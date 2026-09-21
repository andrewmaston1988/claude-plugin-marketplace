import { CLAUDE_ALIASES, isClaudeModel } from "./contracts.mjs";
import { join } from "node:path";
import { checkQuota } from "./quota.mjs";
import { swarmHome } from "./config.mjs";
import { readClaudeCatalog } from "./claude-models.mjs";
import { isUnderRoot, normalizeForCompare } from "./roots.mjs";

const PROVIDER_CAPABILITIES = new Set([
  "discoverModels",
  "readUsage",
  "preflight",
  "invalidateAvailability",
  "costObservations",
]);

// Probe clock. The ollama endpoint is a local daemon: if it is there it answers in
// milliseconds, and if it is not, nothing is gained by waiting longer than this.
const PROBE_TIMEOUT_MS = 2000;

// Shape test local to this module: config.mjs owns its own for the user-file validation
// rules, and importing it here would couple the two.
function isConfigObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function providerConfig(config = {}, id) {
  const canonical = config?.providers?.[id];
  if (canonical && typeof canonical === "object" && !Array.isArray(canonical)) return canonical;
  if (id === "ollama" && config?.provider && typeof config.provider === "object") return config.provider;
  if (id === "codex" && config?.codex && typeof config.codex === "object") return config.codex;
  // A bare codex config has no provider block at all — the file IS the block. Guarded on
  // shape: a `null` config (a hook with no ~/.swarm/config.json yet) satisfied every `!`
  // test and was returned as a null block, crashing any caller that read a key off it.
  if (id === "codex" && isConfigObject(config) && !config.providers && !config.provider && !config.codex) return config;
  return {};
}

// One resolution point for the two levels. A provider entry may only ever REMOVE a root
// from the top-level list — never add one, never replace it — so the result is the
// intersection. Each pair resolves to its NARROWER side by containment: isUnderRoot is
// asymmetric, so "keep whichever side we happened to read" is fail-open (a provider naming
// C:/ against a top-level C:/code would hand back the whole drive), and a set-style
// equality test drops the pair entirely, which looks fail-closed and permits nothing.
//
// `roots` is undefined when NEITHER level configures a list — never configured, which is a
// different refusal from `[]`, the operator's deliberate denial. Collapsing the two would
// silently rewrite the message #302 built. `deniedBy` names the key that actually binds:
// with a bare array the caller can only guess, and guesses send the operator to a key where
// editing the roots has no effect.
export function allowedRootsFor(config = {}, id) {
  const top = Array.isArray(config?.allowedRoots) ? config.allowedRoots : undefined;
  const own = providerConfig(config, id).allowedRoots;
  const topLabel = "allowedRoots";
  // A canonical provider block puts the key under `providers`; the legacy spelling lives at
  // the root of the file. Same rule the refusal text has always used.
  const ownLabel = config?.providers?.[id] ? `providers.${id}.allowedRoots` : "provider.allowedRoots";
  if (own === undefined) return { roots: top, deniedBy: top === undefined ? ownLabel : topLabel };
  if (top === undefined) return { roots: own.slice(), deniedBy: ownLabel };
  return { roots: intersectRoots(own, top), deniedBy: bindsAtTopLevel(own, top) ? topLabel : ownLabel };
}

function intersectRoots(own, top) {
  const out = [];
  const seen = new Set();
  for (const a of own) {
    for (const b of top) {
      const kept = isUnderRoot(a, b) ? a : isUnderRoot(b, a) ? b : null;
      if (kept === null) continue;
      const key = normalizeForCompare(kept);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(kept);
    }
  }
  return out;
}

// True when the top-level list is the closer constraint — it sits under every root the
// provider named, so it is the key whose edit changes what is permitted.
function bindsAtTopLevel(own, top) {
  if (own.every((root) => top.some((t) => isUnderRoot(root, t)))) return false;
  return top.every((root) => own.some((o) => isUnderRoot(root, o)));
}

function adapterShape(adapter) {
  if (!adapter || typeof adapter !== "object") throw new Error("provider adapter must be an object");
  for (const field of ["id", "runnerId"]) {
    if (typeof adapter[field] !== "string" || !/^[a-z][a-z0-9-]*$/.test(adapter[field])) {
      throw new Error(`provider adapter ${field} must be a canonical lowercase identifier`);
    }
  }
  for (const method of ["enabled", "validateTask"]) {
    if (typeof adapter[method] !== "function") throw new Error(`provider '${adapter.id}' requires ${method}()`);
  }
  if (!adapter.capabilities || typeof adapter.capabilities !== "object" || Array.isArray(adapter.capabilities)) {
    throw new Error(`provider '${adapter.id}' capabilities must be an object`);
  }
  for (const [name, capability] of Object.entries(adapter.capabilities)) {
    if (!PROVIDER_CAPABILITIES.has(name)) throw new Error(`provider '${adapter.id}' has unknown capability '${name}'`);
    if (typeof capability !== "function") throw new Error(`provider '${adapter.id}' capability '${name}' must be a function`);
  }
  return adapter;
}

function configured(config, id, fallback) {
  const block = providerConfig(config, id);
  return typeof block?.enabled === "boolean" ? block.enabled : fallback;
}

function descriptor({ id, runnerId, defaultEnabled, validateModel = () => null, capabilities = {} }) {
  return {
    id,
    runnerId,
    enabled: (config) => configured(config, id, defaultEnabled),
    validateTask: (task) => {
      const problem = validateModel(String(task?.model || ""));
      return problem ? [problem] : [];
    },
    capabilities,
  };
}

// A probe with no clock is worse than a probe that fails: it hangs the command that
// ran it. Passing an AbortSignal to fetch is not enough, because a fetch that ignores
// the signal never settles — so the attempt races a timer instead, and the losing
// side is tagged rather than left as a rejection nothing awaits.
async function attemptWithin(run, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ kind: "timeout" }), ms); });
  try {
    const attempt = run().then((value) => ({ kind: "value", value }), (error) => ({ kind: "error", error }));
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function pingOllamaEndpoint({ config, fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const endpoint = providerConfig(config, "ollama").url;
  if (!endpoint) return { ok: true };
  const outcome = await attemptWithin(() => fetch(endpoint), timeoutMs);
  if (outcome.kind === "value") return { ok: true };
  if (outcome.kind === "timeout") {
    return { ok: false, error: `endpoint ${endpoint} did not answer within ${timeoutMs}ms — open-model tasks cannot dispatch. Is the provider running?` };
  }
  return { ok: false, error: `endpoint ${endpoint} is unreachable (${outcome.error.message}) — open-model tasks cannot dispatch. Is the provider running?` };
}

// One uniform answer to "can this provider dispatch right now?", for callers that must
// survive the answer: setup offers to disable a provider, and the provider whose
// preflight throws is exactly the one it has to be able to report. A capability that
// reports success rather than throwing keeps its own `ok`; no preflight at all is not
// a failure — setup must never offer to disable a provider it simply could not ask.
// `fetch` defaults to the global because the caller this exists for — setup's own
// one-liner — has no fetch to inject, and an un-injected one throws "fetch is not a
// function", which the catch below would report as a REFUSAL: setup offering to
// disable a provider whose route was never tried.
export async function probeProvider(id, { config = {}, registry, fetch = globalThis.fetch, ...deps } = {}) {
  const preflight = (registry || createDefaultProviderRegistry()).capability(id, "preflight");
  if (!preflight) return { id, ok: true, detail: null };
  try {
    const r = await preflight({ config, fetch, ...deps });
    if (r?.ok === false) return { id, ok: false, detail: r.error || "preflight reported a failure" };
    return { id, ok: true, detail: null };
  } catch (e) {
    return { id, ok: false, detail: e.message };
  }
}

async function preflightClaude({ config: cfg = {}, fetch, now, io, env, tasks = [] } = {}) {
  if (cfg.quotaPreflight === false) return { ok: true };
  const q = await checkQuota({
    cfg,
    fetch,
    now,
    cachePath: join(swarmHome(env), "quota-cache.json"),
    ...(env?.SWARM_CREDENTIALS && { credentialsPath: env.SWARM_CREDENTIALS }),
  });
  // A scoped limit grounds only the model it names — never the whole roster.
  // Match on the family token, because the two sides are written differently:
  // a leaf says "sonnet" or "claude-sonnet-5"; the endpoint may say "Sonnet"
  // OR "Claude Sonnet 4.5". A bare substring test in one direction misses the
  // multi-word form and would let an exhausted Sonnet bucket dispatch Sonnet.
  const FAMILY_RE = /(fable|opus|sonnet|haiku)/i;
  const familyOf = (s) => (String(s || "").match(FAMILY_RE)?.[1] || "").toLowerCase();
  const blockedScope = (model) =>
    (q?.exhaustedScopes || []).find((s) => {
      const mf = familyOf(model), sf = familyOf(s.scope);
      if (mf && sf) return mf === sf;
      // Scope names an unrecognised model: fall back to a two-way substring
      // test so an unclassifiable exhausted bucket still grounds that leaf.
      const m = String(model).toLowerCase(), sc = String(s.scope || "").toLowerCase();
      return Boolean(sc) && (m.includes(sc) || sc.includes(m));
    });
  if (q?.exhausted || q?.exhaustedScopes?.length) {
    const doomed = tasks.filter(
      (t) => !t.fallbackModel && (q.exhausted || blockedScope(t.model))
    );
    if (doomed.length) {
      const hit = q.exhausted ? q.worst : blockedScope(doomed[0].model);
      const what = q.exhausted
        ? `${hit.kind} at ${hit.percent}%`
        : `the ${hit.scope}-scoped limit is at ${hit.percent}%`;
      throw new Error(
        `Anthropic usage exhausted (${what}` +
        `${hit.resetsAt ? `, resets ${hit.resetsAt}` : ""}) — ` +
        `${doomed.length} Claude leaf(s) cannot dispatch: ${doomed.map((t) => t.id).join(", ")}. ` +
        `Recast to :cloud models, add fallbackModel, or re-run after reset.`
      );
    }
  }
  if (q && !q.exhausted && q.worst.percent >= (cfg.quotaWarnPct ?? 80)) {
    io.stdout(
      `⚠ Anthropic usage at ${q.worst.percent}% (${q.worst.kind}` +
      `${q.worst.resetsAt ? `, resets ${q.worst.resetsAt}` : ""}) — Claude leaves may hit quota mid-run`
    );
  }
  return { ok: true, usage: q };
}

export function defaultProviderAdapters({ codexAdapter, ollamaCapabilities = {} } = {}) {
  return [
    descriptor({
      id: "claude",
      runnerId: "claude",
      defaultEnabled: true,
      validateModel: (model) => isClaudeModel(model) ? null : `model '${model}' is not a Claude model — provider "claude" needs a full id such as "claude-opus-5"`,
      capabilities: { preflight: preflightClaude, discoverModels: readClaudeCatalog },
    }),
    descriptor({
      id: "ollama",
      runnerId: "claude",
      defaultEnabled: true,
      validateModel: (model) => isClaudeModel(model) ? `model '${model}' is a Claude model — use "provider": "claude"` : null,
      capabilities: { preflight: pingOllamaEndpoint, ...ollamaCapabilities },
    }),
    codexAdapter || descriptor({
      id: "codex",
      runnerId: "codex",
      defaultEnabled: false,
    }),
  ];
}

export function createDefaultProviderRegistry({ codexAdapter, ollamaCapabilities, additionalProviders = [] } = {}) {
  const registry = createProviderRegistry(defaultProviderAdapters({ codexAdapter, ollamaCapabilities }));
  for (const adapter of additionalProviders) registry.register(adapter);
  return registry;
}

export function createProviderRegistry(initial = []) {
  const adapters = new Map();

  function register(adapter) {
    const valid = adapterShape(adapter);
    if (adapters.has(valid.id)) throw new Error(`provider '${valid.id}' is already registered`);
    adapters.set(valid.id, valid);
    return valid;
  }

  for (const adapter of initial) register(adapter);

  function get(id) {
    const adapter = adapters.get(String(id || "").toLowerCase());
    if (!adapter) throw new Error(`unknown provider '${id}' (registered: ${[...adapters.keys()].join(", ")})`);
    return adapter;
  }

  function identity(adapter, model, config, allowDisabled) {
    if (!allowDisabled && !adapter.enabled(config)) throw new Error(`provider '${adapter.id}' is disabled`);
    return { provider: adapter.id, model };
  }

  function resolve(task, { config = {}, allowDisabled = false } = {}) {
    const authoredModel = task?.model;
    if (typeof authoredModel !== "string" || !authoredModel.trim()) throw new Error("provider resolution requires a non-empty model");
    const model = authoredModel.trim();
    if (typeof task.provider !== "string" || !task.provider.trim()) {
      throw new Error(
        `model '${model}' has no "provider" — every leaf names one and nothing is inferred. ` +
        `Add "provider" beside "model" (registered: ${[...adapters.keys()].join(", ")}), e.g. { "provider": "claude", "model": "claude-opus-5" }`
      );
    }
    if (CLAUDE_ALIASES.has(model.toLowerCase())) {
      throw new Error(`model '${model}' is a Claude alias, and aliases are not accepted — name the full model id, e.g. "claude-opus-5" with "provider": "claude"`);
    }
    return identity(get(task.provider), model, config, allowDisabled);
  }

  return {
    register,
    get,
    list: () => [...adapters.values()],
    resolve,
    capability(provider, name) {
      if (!PROVIDER_CAPABILITIES.has(name)) throw new Error(`unknown provider capability '${name}'`);
      return get(provider).capabilities[name] || null;
    },
  };
}
