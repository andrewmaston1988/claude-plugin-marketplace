import { mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { swarmHome } from "./config.mjs";
import { modelDescriptor, OLLAMA_CLOUD_RE, identityOf, identityKey } from "./contracts.mjs";
import { providerConfig, createDefaultProviderRegistry } from "./providers.mjs";

// Model discovery — the ollama cloud catalog ONLY: recommendations ∪ /api/tags,
// enriched free via /api/show, family-collapsed, size-ordered. `ollama list` and
// local /v1/models are NEVER used (:cloud names never appear there). Never pulls.

// Bare `name` → `name:cloud`; tagged `name:tag` → `name:tag-cloud` (a tag can
// carry only one colon, so the suffix folds into it). Cloud forms pass through.
export function deriveCloudName(name, suffix = ":cloud") {
  if (name.endsWith(suffix)) return name;
  const tagSuffix = "-" + suffix.replace(/^:/, "");
  if (name.includes(":")) return name.endsWith(tagSuffix) ? name : name + tagSuffix;
  return name + suffix;
}

function parseRecommendations(body, suffix) {
  const recs = Array.isArray(body?.recommendations) ? body.recommendations : [];
  return recs
    .filter((r) => typeof r?.model === "string" && r.model.endsWith(suffix))
    .map((r) => {
      const m = { model: r.model, description: r.description || "" };
      if (r.context_length != null) m.contextLength = r.context_length;
      if (r.required_plan != null) m.requiredPlan = r.required_plan;
      m.source = "recommendations";
      return m;
    });
}

function parseTags(body, suffix) {
  const models = Array.isArray(body?.models) ? body.models : [];
  return models
    .filter((m) => typeof m?.name === "string")
    .map((m) => ({ model: deriveCloudName(m.name, suffix), description: m.description || "", source: "catalog" }));
}

// Last resort: run the interactive picker command, scrape :cloud names from
// its output, then kill it.
export function scrapeDiscoverCmd(cfg, spawnImpl = nodeSpawn, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const suffix = cfg.provider.cloudSuffix || ":cloud";
    const [cmd, ...args] = String(cfg.provider.discoverCmd).split(/\s+/).filter(Boolean);
    let out = "";
    let child;
    try {
      child = spawnImpl(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve([]);
      return;
    }
    const finish = () => {
      const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const names = [...new Set(out.match(new RegExp(`[\\w./-]+${escaped}`, "g")) || [])];
      resolve(names.map((model) => ({ model, description: "" })));
    };
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    if (timer.unref) timer.unref();
    child.on("error", finish);
    child.on("close", () => { clearTimeout(timer); finish(); });
  });
}

// Free validation + enrichment via the daemon. An HTTP error response drops
// the candidate (the daemon affirmatively rejected the name); a throw keeps it
// unvalidated (daemon unreachable — fail open). Order is preserved.
export async function enrichWithShow(models, base, fetchImpl = globalThis.fetch, { concurrency = 6, timeoutMs = 5000 } = {}) {
  const results = new Array(models.length);
  let next = 0;
  async function worker() {
    while (next < models.length) {
      const idx = next++;
      const m = models[idx];
      try {
        const res = await fetchImpl(`${base}/api/show`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: m.model }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) { results[idx] = null; continue; }
        const body = await res.json();
        const out = { ...m };
        if (Array.isArray(body?.capabilities)) out.capabilities = body.capabilities;
        for (const [k, v] of Object.entries(body?.model_info || {})) {
          if (k.endsWith(".context_length") && typeof v === "number") out.contextLength = v;
          if (k === "general.parameter_count" && typeof v === "number") out.parameterCount = v;
        }
        results[idx] = out;
      } catch {
        results[idx] = m;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, models.length) || 1 }, worker));
  return results.filter(Boolean);
}

// Largest first: parameterCount desc, contextLength desc as tiebreak; models
// with no size metadata sort last. Stable — input order breaks remaining ties.
export function sortModelsBySize(models) {
  const rank = (m) => (m.parameterCount > 0 ? m.parameterCount : -1);
  return [...models].sort((a, b) => rank(b) - rank(a) || (b.contextLength || 0) - (a.contextLength || 0));
}

// Lineage parse: strip the cloud suffix back to the catalog name, then split
// the stem on hyphens (plus the tag as one more segment). Each segment either
// matches alpha-prefix + digit-tail (`k2.6` → lineage "k", version 2.6) or is
// pure lineage (variant words like `code`, size tags like `31b`). Two entries
// compete only when their lineage segments match exactly.
export const LINEAGE_ALIASES = Object.freeze({ "kimi-k-code": "kimi-k" });

function parseLineage(name, suffix) {
  let base = name;
  const tagSuffix = "-" + suffix.replace(/^:/, "");
  if (suffix && base.endsWith(suffix)) base = base.slice(0, -suffix.length);
  else if (suffix && base.includes(":") && base.endsWith(tagSuffix)) base = base.slice(0, -tagSuffix.length);
  const [stem, tag] = base.split(":");
  const segments = stem.split("-");
  if (tag) segments.push(tag);
  const lineage = [];
  const version = [];
  let mergeNumeric = false;
  for (const seg of segments) {
    const m = /^([a-z]*)(\d+(\.\d+)*)$/.exec(seg);
    if (!m) { lineage.push(seg); mergeNumeric = false; continue; }
    if (m[1]) lineage.push(m[1]);
    const numbers = m[2].split(".").map(Number);
    const pureNumeric = !m[1] && /^\d+$/.test(seg) && !/^\d{4,}$/.test(seg);
    if (pureNumeric && mergeNumeric) version.at(-1).push(numbers[0]);
    else version.push(numbers);
    mergeNumeric = pureNumeric;
  }
  const nameLineage = lineage.join("-");
  return { lineage: LINEAGE_ALIASES[nameLineage] || nameLineage, version };
}

// Zero-padded compare lets 5 equal 5.0 and sort below 5.1.
function cmpIntArrays(x, y) {
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const a = x[i] ?? 0;
    const b = y[i] ?? 0;
    if (a !== b) return a > b ? 1 : -1;
  }
  return 0;
}

function cmpVersions(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmpIntArrays(a[i], b[i]);
    if (Number.isNaN(c) || c !== 0) return c;
  }
  return a.length === b.length ? 0 : NaN;
}

// Mark each entry's nearest strictly-newer comparable same-lineage sibling as
// `supersededBy`, forming chains (5.0 → 5.1 → 5.2). Display walks the chain;
// nothing is removed here.
export function collapseFamilies(models, suffix = ":cloud") {
  const parsed = models.map((m) => ({ m, ...parseLineage(m.model, suffix) }));
  return parsed.map(({ m, lineage, version }) => {
    let best = null;
    for (const other of parsed) {
      if (other.m === m || other.lineage !== lineage) continue;
      const c = cmpVersions(other.version, version);
      if (Number.isNaN(c) || c <= 0) continue;
      if (!best || cmpVersions(other.version, best.version) < 0) best = other;
    }
    const out = { ...m };
    if (best) out.supersededBy = best.m.model;
    else delete out.supersededBy;
    return out;
  });
}

// Supersession visibility: an entry is hidden iff some entry up its
// supersededBy chain is present and not denylisted. A superseder removed from
// the cache (402 entitlement) simply isn't found, so its elders resurface.
// The denylist itself filters at print time in the caller — injected here as
// a predicate so this module never imports manifest.mjs.
export function visibleModels(models, { isDenylisted = () => false } = {}) {  const byName = new Map(models.map((m) => [m.model, m]));
  const usable = (m) => !isDenylisted(m.model);
  return models.filter((m) => {
    const seen = new Set([m.model]);
    for (let s = byName.get(m.supersededBy); s && !seen.has(s.model); s = byName.get(s.supersededBy)) {
      if (usable(s)) return false;
      seen.add(s.model);
    }
    return true;
  });
}

// Every provider's roster through the lineage collapse, at this one site: the
// cloud suffix belongs to Ollama's naming and every other provider compares
// bare, so a roster that never reached collapseFamilies cannot print a
// superseded generation beside its replacement. Split per provider first — a
// name two providers share must not chain into the other's family.
export function collapseRoster(rows, { cloudSuffix = ":cloud" } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const provider = row?.provider || "ollama";
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(row);
  }
  return [...groups.entries()].flatMap(([provider, group]) =>
    collapseFamilies(group, provider === "ollama" ? cloudSuffix : ""));
}

// The key a supersession reading is looked up by. Provider-qualified at this one
// site: two providers that share a model name must never chain into each other's
// family, and every caller of the map below has to agree on the tuple shape.
export const supersessionKey = (provider, model) => JSON.stringify([provider, model]);

// Which rows a collapse hides, as provider+model -> the model that supersedes it.
// `collapseFamilies` marks chains; `visibleModels` decides which of a chain are
// actually shown, and only the hidden members land here.
export function supersededByMap(rows, { providerKey = () => "unqualified", isDenylisted = () => false, cloudSuffix = ":cloud" } = {}) {
  const familyNames = new Map();
  for (const row of rows) {
    const provider = providerKey(row);
    const names = familyNames.get(provider) || new Set();
    names.add(row.model);
    familyNames.set(provider, names);
  }
  const superseded = new Map();
  for (const [provider, names] of familyNames) {
    const suffix = provider === "ollama" ? cloudSuffix : "";
    const families = collapseFamilies([...names].map((model) => ({ model })), suffix);
    const visible = new Set(visibleModels(families, { isDenylisted }).map((row) => row.model));
    for (const row of families) {
      if (!visible.has(row.model) && row.supersededBy) {
        superseded.set(supersessionKey(provider, row.model), row.supersededBy);
      }
    }
  }
  return superseded;
}

// The same reading applied to a table: superseded rows leave, unless `keep` says
// otherwise — a card's base model is the unit every other row is a multiple of,
// so it is never the row that goes.
export function dropSuperseded(rows, { providerKey = () => "unqualified", keep = () => false, cloudSuffix = ":cloud", isDenylisted = () => false } = {}) {
  const superseded = supersededByMap(rows, { providerKey, cloudSuffix, isDenylisted });
  return rows.filter((row) => keep(row) || !superseded.has(supersessionKey(providerKey(row), row.model)));
}

export async function discoverModels(cfg, fetchImpl = globalThis.fetch, { spawnImpl } = {}) {
  const suffix = cfg.provider.cloudSuffix || ":cloud";
  const base = String(cfg.provider.url).replace(/\/+$/, "");
  const catalog = String(cfg.provider.catalogUrl || "https://ollama.com").replace(/\/+$/, "");
  let recs = [];
  for (const url of [
    `${base}/api/experimental/model-recommendations`,
    `${catalog}/api/experimental/model-recommendations`,
  ]) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) continue;
      const parsed = parseRecommendations(await res.json(), suffix);
      if (parsed.length) { recs = parsed; break; }
    } catch {
      continue; // endpoint down or shape unexpected — walk the chain
    }
  }
  let tags = [];
  try {
    const res = await fetchImpl(`${catalog}/api/tags`);
    if (res.ok) tags = parseTags(await res.json(), suffix);
  } catch {
    // catalog unreachable — recommendations alone still serve
  }
  const merged = new Map();
  for (const t of tags) merged.set(t.model, t);
  for (const r of recs) merged.set(r.model, { ...merged.get(r.model), ...r });
  if (!merged.size) {
    const scraped = await scrapeDiscoverCmd(cfg, spawnImpl);
    if (scraped.length) return sortModelsBySize(collapseFamilies(scraped, suffix));
    throw new Error(
      "model discovery failed: recommendations endpoints, catalog, and discoverCmd all yielded nothing — " +
      "is ollama running and >= the version that serves /api/experimental/model-recommendations?"
    );
  }
  return sortModelsBySize(collapseFamilies(await enrichWithShow([...merged.values()], base, fetchImpl), suffix));
}

// Matches ollama's 402 body for a model priced "extra usage" with an empty
// balance. The scheduler greps leaf failure output with this; the refresh
// probe greps the HTTP body.
export const ENTITLEMENT_RE = /uses extra usage only|extra usage balance is empty/i;

// Drop one model from the cache (a 402 said the account can't run it). The
// roster then simply doesn't offer it — no funding-state claim is recorded,
// and the next refresh restores it if the probe/dispatch stops 402ing.
// Missing cache or entry is a silent no-op.
export function removeCachedModel(model, env = process.env, provider) {
  let parsed;
  try { parsed = readRosterFile(env); } catch { return; }
  if (!parsed || typeof parsed !== "object") return;
  const wanted = identityOf(model);
  const wantedProvider = provider && identityOf({ model: wanted.model, provider }).provider;
  const matches = (row) => {
    if (!row?.model) return false;
    const identity = identityOf(row);
    if (identity.model !== wanted.model) return false;
    // Legacy: a provider-less row matches any eviction; an eviction without a
    // provider matches any row.
    if (!row.provider || !wantedProvider) return true;
    return identity.provider === wantedProvider;
  };
  // An old-shape file has no entries to edit: the row leaves the flat list, so a
  // 402 eviction is never a silent no-op on the way through the rebuild.
  if (Array.isArray(parsed.models)) {
    if (!parsed.models.some(matches)) return;
    parsed.models = parsed.models.filter((row) => !matches(row));
    writeRosterFile(parsed, env);
    return;
  }
  const providers = isPlainObject(parsed.providers) ? parsed.providers : {};
  let changed = false;
  for (const [id, entry] of Object.entries(providers)) {
    const rows = Array.isArray(entry?.models) ? entry.models : [];
    if (!rows.some(matches)) continue;
    providers[id] = { ...entry, models: rows.filter((row) => !matches(row)) };
    changed = true;
  }
  if (changed) writeRosterEnvelope(providers, env);
}

// Bounded entitlement probe, discovery-refresh path only: a one-token generate at
// each cloud model in the visible top 3. A 402 matching ENTITLEMENT_RE removes the
// row (free — rejected before billing); anything else fails open. Removals can
// resurface elders into the top 3, so the slice re-derives, capped at maxProbes.
// Non-cloud names occupy their slot but are NEVER probed (local generate forbidden).
export async function probeTopModels(models, base, fetchImpl = globalThis.fetch, {
  env = process.env, isDenylisted, timeoutMs = 15000, maxProbes = 6, provider,
} = {}) {
  let live = [...models];
  const probed = new Set();
  while (probed.size < maxProbes) {
    const top = visibleModels(live, { isDenylisted }).filter((m) => !isDenylisted?.(m.model)).slice(0, 3);
    const next = top.find((m) => !probed.has(m.model) && OLLAMA_CLOUD_RE.test(m.model));
    if (!next) break;
    probed.add(next.model);
    try {
      const res = await fetchImpl(`${base}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: next.model, prompt: "hi", stream: false, options: { num_predict: 1 } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok && ENTITLEMENT_RE.test(await res.text())) {
        removeCachedModel(next.model, env, provider);
        live = live.filter((m) => m.model !== next.model);
      }
    } catch {
      // daemon unreachable mid-probe — keep the row
    }
  }
  return live;
}

// One reading of where the ollama block lives, shared with providerConfig. The early
// return this replaced treated a config carrying BOTH shapes as legacy-only, so
// providers.ollama was silently ignored here while every other module read it.
function ollamaConfig(config = {}) {
  const block = providerConfig(config, "ollama");
  // Neither shape present: the bare config IS the block, as it always was.
  return { ...config, provider: Object.keys(block).length ? block : config };
}

export function normalizeOllamaModelDescriptor(row) {
  const model = typeof row === "string" ? row : row?.model;
  if (!model) throw new Error("Ollama discovery row requires a model");
  const descriptor = {
    provider: "ollama",
    model,
    runner: "claude",
  };
  const source = typeof row === "object" ? row : {};
  for (const field of ["displayName", "efforts", "defaultEffort", "modalities", "isDefault", "availability"]) {
    if (source[field] !== undefined) descriptor[field] = source[field];
  }
  if (descriptor.displayName === undefined && source.description) descriptor.displayName = source.description;
  return modelDescriptor(descriptor);
}

// Concrete provider-facing discovery. The legacy discoverModels() above keeps
// returning Ollama's rich raw rows for the existing CLI and cache consumers.
export async function discoverOllamaModels(config = {}, options = {}) {
  const raw = await discoverModels(
    ollamaConfig(config),
    options.fetchImpl || globalThis.fetch,
    { spawnImpl: options.spawnImpl },
  );
  return raw.map((row) => {
    const descriptor = normalizeOllamaModelDescriptor(row);
    // The registry contract is deliberately compact. Operator surfaces may
    // request the discovery metadata that makes the catalogue useful without
    // making every provider expose a legacy-shaped row.
    return options.rich ? { ...row, ...descriptor } : descriptor;
  });
}

export function createOllamaProviderAdapter(options = {}) {
  return {
    id: "ollama",
    runnerId: "claude",
    enabled(config = {}) {
      const value = config.providers?.ollama?.enabled ?? config.provider?.enabled;
      return typeof value === "boolean" ? value : true;
    },
    validateTask() {
      return [];
    },
    capabilities: {
      discoverModels(context = {}) {
        return discoverOllamaModels(context.config || context.cfg || options.config || {}, {
          ...options,
          ...context,
        });
      },
      // Scheduler and hooks need a bounded, cache-only read. A live provider
      // fetch remains an explicit operator action (`ollama-usage`).
      async readUsage(context = {}) {
        const cfg = context.config || context.cfg || options.config || {};
        const meter = cfg.providers?.ollama?.cloud?.ollama || cfg.provider?.cloud?.ollama;
        if (meter && meter.enabled !== true) return null;
        const { usageFromCache } = await import("./ollama-usage.mjs");
        return usageFromCache(cfg, context.env || process.env);
      },
    },
  };
}

// ── The roster: one file, one entry per provider, one reader ──
//
// The cache holds every provider's rows under its own entry, because each
// provider's roster goes stale for its own reason: Claude's on a catalog file
// changing, the network providers on a clock. `updated` and a flat list could
// express neither.

// Network providers age on the same 12h the price cards do, so a roster and the
// prices drawn from it are never half a day apart.
export const ROSTER_TTL_MS = 12 * 60 * 60_000;

const ROSTER_FILENAME = "models-cache.json";
const rosterPath = (env) => join(swarmHome(env), ROSTER_FILENAME);

// A writer's own tmp name: two processes banking at once must not share one.
const rosterTmpPath = (env, pid = process.pid) => `${rosterPath(env)}.${pid}.tmp`;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Missing file is a first-ever install. Anything else is loud: a truncated cache
// must never read as an empty roster, which would blank the one the operator can
// still dispatch from.
function readRosterFile(env) {
  const p = rosterPath(env);
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`models cache is unreadable: ${p} (${error?.message || error})`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`models cache is unreadable: ${p} (${error?.message || error})`);
  }
}

function writeRosterFile(value, env) {
  const dir = swarmHome(env);
  mkdirSync(dir, { recursive: true });
  const tmp = rosterTmpPath(env);
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, rosterPath(env));
  return rosterPath(env);
}

const writeRosterEnvelope = (providers, env) => writeRosterFile({ providers }, env);

// The roster as every reader sees it. A file in the old `{ updated, models }`
// shape reads as no entries at all: everything in it is re-derivable, so the
// upgrade rebuilds rather than carrying a migration forever.
export function readRosterEnvelope(env = process.env) {
  const parsed = readRosterFile(env);
  return isPlainObject(parsed?.providers) ? { providers: parsed.providers } : { providers: {} };
}

// Re-read, replace one entry, rename. The read is inside the write because the
// other providers' entries are the rows this one must not disturb.
export function writeRosterEntry(provider, entry, env = process.env) {
  writeRosterEnvelope({ ...readRosterEnvelope(env).providers, [provider]: entry }, env);
  return entry;
}

// Every entry's rows as one flat list, deduped by identity — the composite the
// single flat cache used to hold.
function rosterModels(providers = {}) {
  return mergeProviderModelCaches(Object.values(providers).map((entry) => entry?.models || []));
}

export function providerQualifiedModels(provider, models = []) {
  return models.map((row) => ({
    ...(typeof row === "object" && row ? row : { model: row }),
    provider,
  }));
}

export function mergeProviderModelCaches(caches = []) {
  const merged = new Map();
  for (const cache of caches) {
    for (const row of cache || []) {
      if (!row?.model) continue;
      // Keyed through the identity reading, so 'Codex'/'codex' cannot split a
      // model's roster row in two and 402 eviction can still find it.
      const identity = identityOf(row);
      const provider = identity.provider || "ollama";
      merged.set(identityKey(identity), { ...row, model: identity.model, provider });
    }
  }
  return [...merged.values()];
}

const hydrationOf = (adapter) => adapter.rosterHydration ?? "network";

function rosterStale(adapter, entry, context) {
  const declared = adapter.capabilities.rosterStale;
  if (declared) return declared(entry, context);
  if (!entry) return true;
  return context.now - entry.hydratedAt >= ROSTER_TTL_MS;
}

function rosterSource(registry, adapter, context) {
  const declared = registry.capability(adapter.id, "rosterSource");
  return declared ? declared(context) : null;
}

// The zero-row rules, in one place: an empty answer over cached rows keeps them
// and says why; a first-ever empty is written without an error, because "this
// provider has no models" is not the same answer as "the fetch failed".
function bankRosterEntry(id, { rows, prior, source, now, env, errors }) {
  const models = providerQualifiedModels(id, rows);
  if (!models.length && prior?.models?.length) {
    const message = `model discovery returned no rows for ${id} — kept the ${prior.models.length} cached model(s)`;
    errors[id] = message;
    writeRosterEntry(id, { ...prior, source, lastError: message }, env);
    return;
  }
  writeRosterEntry(id, { hydratedAt: now, source, models }, env);
}

function recordRosterFailure(id, error, { prior, env, errors }) {
  const message = error?.message || String(error);
  errors[id] = message;
  if (prior) writeRosterEntry(id, { ...prior, lastError: message }, env);
}

// The one reader. Local hydrations run inline — Claude's catalog is a file on
// this machine — and network ones never do: validate, run and the dashboard call
// this on a synchronous path, so it must not await anything.
export function modelRoster({ env = process.env, config = {}, registry, now = Date.now() } = {}) {
  const providers = registry || createDefaultProviderRegistry();
  const envelope = readRosterEnvelope(env);
  const errors = {};
  for (const adapter of providers.list()) {
    if (hydrationOf(adapter) !== "local" || !adapter.enabled(config)) continue;
    const entry = envelope.providers[adapter.id];
    const context = { config, env, now };
    if (!rosterStale(adapter, entry, context)) continue;
    const discover = providers.capability(adapter.id, "discoverModels");
    if (!discover) continue;
    let rows;
    try {
      rows = discover({ config, env, rich: false });
    } catch (error) {
      recordRosterFailure(adapter.id, error, { prior: entry, env, errors });
      continue;
    }
    // A promise here would make the reader async and put a network call on
    // validate's path. Refuse it and serve what is already banked.
    if (rows && typeof rows.then === "function") {
      errors[adapter.id] = `local hydration for ${adapter.id} must be synchronous — serving the cached rows`;
      continue;
    }
    bankRosterEntry(adapter.id, {
      rows: Array.isArray(rows) ? rows : [],
      prior: entry,
      source: rosterSource(providers, adapter, { config, env, now }),
      now,
      env,
      errors,
    });
  }
  return { models: rosterModels(readRosterEnvelope(env).providers), errors };
}

// The network half, called only where a network call is already expected:
// `swarm models`, and the dashboard's background fire.
export async function refreshRoster({
  env = process.env, config = {}, registry, now = Date.now(), force = false, rich = false, fetchImpl, spawnImpl,
} = {}) {
  const providers = registry || createDefaultProviderRegistry();
  // Read first: an unreadable cache must throw before anything is written.
  const envelope = readRosterEnvelope(env);
  const errors = {};
  for (const adapter of providers.list()) {
    if (hydrationOf(adapter) !== "network" || !adapter.enabled(config)) continue;
    const entry = envelope.providers[adapter.id];
    if (!force && !rosterStale(adapter, entry, { config, env, now })) continue;
    const discover = providers.capability(adapter.id, "discoverModels");
    if (!discover) continue;
    const prior = readRosterEnvelope(env).providers[adapter.id];
    const source = rosterSource(providers, adapter, { config, env, now });
    try {
      const rows = await discover({ config, env, fetchImpl, spawnImpl, rich });
      bankRosterEntry(adapter.id, { rows: Array.isArray(rows) ? rows : [], prior, source, now, env, errors });
    } catch (error) {
      recordRosterFailure(adapter.id, error, { prior, env, errors });
    }
  }
  return { models: rosterModels(readRosterEnvelope(env).providers), errors };
}

// ── The flat-file callers, until they move onto the reader above ──

export function readModelsCache(env = process.env) {
  const parsed = readRosterFile(env);
  if (parsed === null) return null;
  if (!isPlainObject(parsed?.providers)) return parsed;
  const banked = Object.values(parsed.providers).map((entry) => Number(entry?.hydratedAt) || 0);
  return {
    updated: new Date(Math.max(0, ...banked)).toISOString(),
    models: rosterModels(parsed.providers),
  };
}

export function writeCompositeModelsCache(models, env = process.env) {
  const byProvider = new Map();
  for (const row of mergeProviderModelCaches([models])) {
    const provider = row.provider || "ollama";
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider).push(row);
  }
  const providers = {};
  for (const [provider, rows] of byProvider) {
    providers[provider] = { hydratedAt: Date.now(), source: null, models: rows };
  }
  return writeRosterEnvelope(providers, env);
}

// Refresh only the providers named by discoverers. A failed provider keeps its
// previous rows while successful providers are replaced.
export async function refreshModelsCache({
  config = {},
  env = process.env,
  providers,
  registry,
  discoverers = {},
  fetchImpl,
  spawnImpl,
  rich = false,
} = {}) {
  readRosterEnvelope(env);
  const errors = {};
  const now = Date.now();
  const targets = providers || (registry
    ? registry.list().filter((adapter) => adapter.enabled(config) && adapter.capabilities.discoverModels).map((adapter) => adapter.id)
    : ["ollama"]);
  for (const provider of targets) {
    const adapter = registry?.list().find((candidate) => candidate.id === provider) || null;
    const discover = discoverers[provider]
      || (registry ? registry.capability(provider, "discoverModels") : null)
      || (provider === "ollama" ? (context) => discoverOllamaModels(context.config, context) : null);
    if (!discover) continue;
    const prior = readRosterEnvelope(env).providers[provider];
    const source = adapter ? rosterSource(registry, adapter, { config, env, now }) : null;
    try {
      const rows = await discover({ config, env, fetchImpl, spawnImpl, rich });
      bankRosterEntry(provider, { rows: Array.isArray(rows) ? rows : [], prior, source, now, env, errors });
    } catch (error) {
      recordRosterFailure(provider, error, { prior, env, errors });
    }
  }
  return { models: rosterModels(readRosterEnvelope(env).providers), path: rosterPath(env), errors };
}
