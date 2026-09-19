import { isClaudeModel } from "./contracts.mjs";
import { join } from "node:path";
import { checkQuota } from "./quota.mjs";
import { swarmHome } from "./config.mjs";

const PROVIDER_CAPABILITIES = new Set([
  "discoverModels",
  "readUsage",
  "preflight",
  "invalidateAvailability",
  "costObservations",
]);

export function providerConfig(config = {}, id) {
  const canonical = config?.providers?.[id];
  if (canonical && typeof canonical === "object" && !Array.isArray(canonical)) return canonical;
  if (id === "ollama" && config?.provider && typeof config.provider === "object") return config.provider;
  if (id === "codex" && config?.codex && typeof config.codex === "object") return config.codex;
  if (id === "codex" && !config?.providers && !config?.provider && !config?.codex) return config;
  return {};
}

function adapterShape(adapter) {
  if (!adapter || typeof adapter !== "object") throw new Error("provider adapter must be an object");
  for (const field of ["id", "runnerId"]) {
    if (typeof adapter[field] !== "string" || !/^[a-z][a-z0-9-]*$/.test(adapter[field])) {
      throw new Error(`provider adapter ${field} must be a canonical lowercase identifier`);
    }
  }
  for (const method of ["enabled", "matchModel", "validateTask"]) {
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

function descriptor({ id, runnerId, defaultEnabled, matchModel, capabilities = {} }) {
  return {
    id,
    runnerId,
    enabled: (config) => configured(config, id, defaultEnabled),
    matchModel,
    validateTask: () => [],
    capabilities,
  };
}

async function pingOllamaEndpoint({ config, fetch } = {}) {
  const endpoint = providerConfig(config, "ollama").url;
  if (!endpoint) return { ok: true };
  try {
    await fetch(endpoint);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `endpoint ${endpoint} is unreachable (${e.message}) — open-model tasks cannot dispatch. Is the provider running?` };
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

export function defaultProviderAdapters({ codexAdapter } = {}) {
  return [
    descriptor({
      id: "claude",
      runnerId: "claude",
      defaultEnabled: true,
      matchModel: (model) => isClaudeModel(model) ? { provider: "claude", model } : null,
      capabilities: { preflight: preflightClaude },
    }),
    descriptor({
      id: "ollama",
      runnerId: "claude",
      defaultEnabled: true,
      matchModel: (model) => /(:|-)cloud$/i.test(String(model || "")) ? { provider: "ollama", model } : null,
      capabilities: { preflight: pingOllamaEndpoint },
    }),
    codexAdapter || descriptor({
      id: "codex",
      runnerId: "codex",
      defaultEnabled: false,
      matchModel: (model, cache = []) => cache.some((row) => row?.provider === "codex" && row?.model === model)
        ? { provider: "codex", model }
        : null,
    }),
  ];
}

export function createDefaultProviderRegistry({ codexAdapter } = {}) {
  return createProviderRegistry(defaultProviderAdapters({ codexAdapter }));
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
    if (!adapter) throw new Error(`unknown provider '${id}'`);
    return adapter;
  }

  function identity(adapter, model, config, allowDisabled) {
    if (!allowDisabled && !adapter.enabled(config)) throw new Error(`provider '${adapter.id}' is disabled`);
    return { provider: adapter.id, model };
  }

  function resolve(task, { cache = [], config = {}, allowDisabled = false } = {}) {
    const authoredModel = task?.model;
    if (typeof authoredModel !== "string" || !authoredModel.trim()) throw new Error("provider resolution requires a non-empty model");
    const model = authoredModel.trim();
    if (task.provider !== undefined) return identity(get(task.provider), model, config, allowDisabled);

    const cacheProviders = [...new Set(cache
      .filter((row) => row?.model === model && typeof row?.provider === "string")
      .map((row) => row.provider.toLowerCase()))];
    if (cacheProviders.length > 1) {
      throw new Error(`model '${model}' exists under multiple providers (${cacheProviders.join(", ")}) — set provider explicitly`);
    }
    if (cacheProviders.length === 1) return identity(get(cacheProviders[0]), model, config, allowDisabled);

    const matches = [];
    for (const adapter of adapters.values()) {
      const match = adapter.matchModel(model, cache);
      if (match) matches.push({ adapter, match });
    }
    if (matches.length > 1) {
      throw new Error(`model '${model}' matches multiple providers (${matches.map(({ adapter }) => adapter.id).join(", ")}) — set provider explicitly`);
    }
    if (matches.length === 1) {
      const { adapter, match } = matches[0];
      if (match.provider !== adapter.id || match.model !== model) {
        throw new Error(`provider '${adapter.id}' matchModel() returned a mismatched identity`);
      }
      return identity(adapter, model, config, allowDisabled);
    }
    return identity(get("ollama"), model, config, allowDisabled);
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
