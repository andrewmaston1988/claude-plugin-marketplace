import { mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { swarmHome } from "./config.mjs";
import { modelDescriptor, OLLAMA_CLOUD_RE, identityOf, identityKey } from "./contracts.mjs";
import { providerConfig } from "./providers.mjs";

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
  if (base.endsWith(suffix)) base = base.slice(0, -suffix.length);
  else if (base.includes(":") && base.endsWith(tagSuffix)) base = base.slice(0, -tagSuffix.length);
  const [stem, tag] = base.split(":");
  const segments = stem.split("-");
  if (tag) segments.push(tag);
  const lineage = [];
  const version = [];
  for (const seg of segments) {
    const m = /^([a-z]*)(\d+(\.\d+)*)$/.exec(seg);
    if (!m) { lineage.push(seg); continue; }
    if (m[1]) lineage.push(m[1]);
    version.push(m[2].split(".").map(Number));
  }
  const nameLineage = lineage.join("-");
  return { lineage: LINEAGE_ALIASES[nameLineage] || nameLineage, version };
}

// Element-wise compare; a strict prefix of the other is incomparable (NaN) —
// `k3` vs `k3:0901` is a variant fork, not an ordering.
function cmpIntArrays(x, y) {
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return x.length === y.length ? 0 : NaN;
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
export function visibleModels(models, { isDenylisted = () => false } = {}) {
  const byName = new Map(models.map((m) => [m.model, m]));
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
  const p = join(swarmHome(env), "models-cache.json");
  let cache;
  try { cache = JSON.parse(readFileSync(p, "utf8")); } catch { return; }
  const models = Array.isArray(cache?.models) ? cache.models : [];
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
  if (!models.some(matches)) return;
  cache.models = models.filter((m) => !matches(m));
  writeFileSync(p + ".tmp", JSON.stringify(cache, null, 2) + "\n");
  renameSync(p + ".tmp", p);
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

export function readModelsCache(env = process.env) {
  const p = join(swarmHome(env), "models-cache.json");
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (error) {
    // Missing file = first-ever install. Anything else (truncated, hand-edited)
    // must be loud: silent null disarms the zero-row protection in
    // refreshModelsCache and blanks the roster.
    if (error?.code === "ENOENT") return null;
    throw new Error(`models cache is unreadable: ${p} (${error?.message || error})`);
  }
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


export function writeCompositeModelsCache(models, env = process.env) {
  const dir = swarmHome(env);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "models-cache.json");
  const qualified = mergeProviderModelCaches([models]);
  writeFileSync(p + ".tmp", JSON.stringify({ updated: new Date().toISOString(), models: qualified }, null, 2) + "\n");
  renameSync(p + ".tmp", p);
  return p;
}

// Refresh only the providers named by discoverers. A failed provider keeps its
// previous rows while successful providers are replaced atomically in one file.
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
  const cached = readModelsCache(env);
  const existing = Array.isArray(cached?.models) ? cached.models : [];
  const byProvider = new Map();
  for (const row of existing) {
    const provider = row?.provider || "ollama";
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider).push({ ...row, provider });
  }
  const errors = {};
  const targets = providers || (registry
    ? registry.list().filter((adapter) => adapter.enabled(config) && adapter.capabilities.discoverModels).map((adapter) => adapter.id)
    : ["ollama"]);
  for (const provider of targets) {
    const discover = discoverers[provider]
      || (registry ? registry.capability(provider, "discoverModels") : null)
      || (provider === "ollama" ? (context) => discoverOllamaModels(context.config, context) : null);
    if (!discover) continue;
    try {
      const rows = await discover({ config, env, fetchImpl, spawnImpl, rich });
      if (!rows.length) {
        // A resolve with zero rows (an empty 200, a provider mid-outage) is not
        // the same answer as "this provider has no models". Where a roster is
        // already cached, keep it and say so; a first-ever empty is written.
        const cached = mergeProviderModelCaches([readModelsCache(env)?.models || []])
          .filter((row) => row.provider === provider);
        if (cached.length) {
          byProvider.set(provider, cached);
          errors[provider] = `model discovery returned no rows for ${provider} — kept the ${cached.length} cached model(s)`;
          continue;
        }
      }
      byProvider.set(provider, providerQualifiedModels(provider, rows));
    } catch (error) {
      errors[provider] = error?.message || String(error);
    }
  }
  const models = mergeProviderModelCaches([...byProvider.values()]);
  const path = writeCompositeModelsCache(models, env);
  return { models, path, errors };
}
