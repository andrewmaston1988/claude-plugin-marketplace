// One answer to one question: how much headroom does each provider have right
// now? Anthropic and every cloud provider reach this module in the SAME shape,
// so `quota`, the standing-mode hook and anything later all read one source.
//
// The shape is `parseUsageLimits`'s, because it already fits: a provider is a
// name, a verdict, and a list of limit windows. Ollama's session/weekly bars
// normalise INTO it rather than growing a parallel vocabulary — adding a second
// cloud provider is then one reader, not another command and another cache and
// another warning string.
//
// Split as the rest of this plugin splits: `normalize*` are pure over a reading,
// `readCachedUsage` is the one function that touches disk. It is called from a
// UserPromptSubmit hook, so it must never fetch, never block and never throw; a
// provider it cannot read is `unknown` and says nothing at all.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { swarmHome } from "./config.mjs";
import { providerUsageSnapshot } from "./contracts.mjs";

export const QUOTA_CACHE_FILENAME = "quota-cache.json";

// A limit window, uniform across providers. `scope` is Anthropic's per-model
// bucket; cloud providers have no equivalent and leave it null.
function limit(kind, percent, resetsAt, scope = null) {
  return { kind, percent, resetsAt: resetsAt ?? null, scope };
}

function asOf(value = Date.now()) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function snapshot(provider, buckets, { source = "unknown", provenance = "none", asOf: at = Date.now() } = {}) {
  return providerUsageSnapshot({ provider, buckets, source, provenance, asOf: asOf(at) });
}

const none = (provider, options = {}) => ({
  ...snapshot(provider, [], options),
  provider,
  state: "unknown",
  limits: [],
});

// Pure over `parseUsageLimits`'s output (the `result` half of the quota cache,
// or a fresh fetch).
export function normalizeAnthropic(parsed, options = {}) {
  if (!parsed?.limits?.length) return none("anthropic", { source: "anthropic-oauth-usage", ...options });
  const limits = parsed.limits.map((l) => limit(l.kind, l.percent, l.resetsAt, l.scope ?? null));
  return {
    ...snapshot("anthropic", limits, { source: "anthropic-oauth-usage", provenance: options.provenance || "live", asOf: options.asOf }),
    provider: "anthropic",
    state: parsed.exhausted ? "exhausted" : "ok",
    limits,
  };
}

// Pure over `readUsage`'s output. Provenance fields ride through so the
// banner can be worded from the SAME shape every consumer holds.
export function normalizeOllama(reading, options = {}) {
  if (!reading || reading.state === "unknown") return none("ollama", { source: "ollama-settings", ...options });
  const limits = [];
  if (typeof reading.sessionPctUsed === "number") {
    limits.push(limit("session", reading.sessionPctUsed, reading.sessionResetsAt));
  }
  if (typeof reading.weeklyPctUsed === "number") {
    limits.push(limit("weekly", reading.weeklyPctUsed, reading.resetsAt ?? reading.weeklyResetsAt));
  }
  return {
    ...snapshot("ollama", limits, {
      source: options.source || "ollama-settings",
      provenance: options.provenance || reading.provenance || "live",
      asOf: options.asOf || reading.fetchedAt,
    }),
    provider: "ollama",
    state: reading.state,
    limits,
    ...(reading.provenance !== undefined && { provenance: reading.provenance }),
    ...(reading.reason != null && { reason: reading.reason }),
    ...(reading.lastSeen != null && { lastSeen: reading.lastSeen }),
    ...(reading.cookiePath != null && { cookiePath: reading.cookiePath }),
  };
}

function codexLimitBuckets(buckets) {
  const limits = [];
  for (const bucket of buckets || []) {
    if (!bucket || bucket.kind !== "rate-limit") continue;
    const id = bucket.limitId || "limit";
    const entries = ["primary", "secondary"].filter((name) => bucket[name] && typeof bucket[name] === "object")
      .map((name) => [name, bucket[name]]);
    if (!entries.length) entries.push(["", bucket]);
    for (const [name, value] of entries) {
      const percent = value.usedPercent ?? value.used_percent ?? value.percent;
      if (typeof percent !== "number") continue;
      limits.push(limit(name ? `${id} ${name}` : id, percent, value.resetsAt ?? value.resets_at ?? null, id));
    }
  }
  return limits;
}

// Codex account usage is deliberately retained in `buckets` but is not
// flattened into a quota bar. Rate-limit ids are the dispatch/headroom view;
// account summaries and daily buckets are account measurements, not leaf cost.
export function normalizeCodex(reading, options = {}) {
  const source = reading?.provider === "codex" && Array.isArray(reading.buckets) ? reading : { provider: "codex", buckets: [] };
  const limits = codexLimitBuckets(source.buckets);
  return {
    ...snapshot("codex", source.buckets, {
      source: source.source || options.source || "codex-app-server",
      provenance: source.provenance || options.provenance || "none",
      asOf: source.asOf || options.asOf,
    }),
    provider: "codex",
    state: limits.some((entry) => entry.percent >= 100) ? "exhausted" : limits.length ? "ok" : "unknown",
    limits,
  };
}

// Providers whose reading needs its own shape read. Anything absent here takes the
// generic path below, so a registry-only provider is normalized without a code change.
const PROVIDER_NORMALIZERS = {
  ollama: (reading) => normalizeOllama(reading),
  codex: (reading) => normalizeCodex(reading),
};

export function normalizeProviderUsage(provider, reading) {
  if (!reading) return null;
  const own = PROVIDER_NORMALIZERS[provider];
  if (own) return own(reading);
  const limits = Array.isArray(reading.limits) ? reading.limits : (reading.buckets || [])
    .filter((bucket) => typeof bucket?.percent === "number" || typeof bucket?.usedPercent === "number")
    .map((bucket) => limit(bucket.kind || "usage", bucket.percent ?? bucket.usedPercent, bucket.resetsAt ?? bucket.resets_at, bucket.scope ?? null));
  return {
    ...snapshot(provider, reading.buckets || [], {
      source: reading.source || `${provider}-usage`,
      provenance: reading.provenance || "unknown",
      asOf: reading.asOf,
    }),
    provider,
    state: reading.state || (limits.some((entry) => entry.percent >= 100) ? "exhausted" : limits.length ? "ok" : "unknown"),
    limits,
  };
}

// Anthropic's cache is a TTL cache the CLI refills on demand, so an EXPIRED one
// is `unknown`, never bannered: the next `quota` call refreshes it unprompted
// and a warning here would be noise the reader can do nothing about. Ollama is
// the opposite — its credential is a browser cookie a human pastes in — which is
// why only ollama's readings carry provenance and the /!\ banner. That
// asymmetry is real; flattening it would either spam a warning Anthropic fixes
// silently, or bury one only the operator can fix.
function readAnthropicCache(cfg, now, cachePath) {
  let cached;
  try {
    cached = JSON.parse(readFileSync(cachePath || join(swarmHome(), QUOTA_CACHE_FILENAME), "utf8"));
  } catch {
    return none("anthropic");
  }
  if (typeof cached?.ts !== "number") return none("anthropic");
  if (now - cached.ts >= (cfg.quotaCacheSecs ?? 300) * 1000) return none("anthropic");
  return normalizeAnthropic(cached.result, { source: "anthropic-oauth-cache", provenance: "cache", asOf: cached.ts });
}

// Every provider, in one array, cache-only. Callers that can afford a fetch (the
// `quota` subcommand) fetch first and normalize the fresher reading themselves.
export async function readCachedUsage(cfg = {}, { env = process.env, now = Date.now(), cachePath, _ollama, _codex, providerRegistry } = {}) {
  const out = [readAnthropicCache(cfg, now, cachePath)];
  if (providerRegistry) {
    for (const adapter of providerRegistry.list()) {
      if (adapter.id === "claude" || !adapter.enabled(cfg)) continue;
      const readUsage = adapter.capabilities.readUsage;
      if (!readUsage) continue;
      try {
        const reading = await readUsage({ config: cfg, env, now, usageOptIn: false });
        const normalized = normalizeProviderUsage(adapter.id, reading);
        if (normalized) out.push(normalized);
      } catch {
        // A standing hook must remain cache-only and best-effort. A provider
        // that cannot answer is represented only when its adapter can name it.
        out.push(normalizeProviderUsage(adapter.id, null) || none(adapter.id));
      }
    }
    return out;
  }
  const ollamaEnabled = cfg?.providers?.ollama?.cloud?.ollama?.enabled === true || cfg?.provider?.cloud?.ollama?.enabled === true;
  if (ollamaEnabled) {
    const { usageFromCache } = _ollama || (await import("./ollama-usage.mjs"));
    try {
      out.push(normalizeOllama(usageFromCache(cfg, env)));
    } catch {
      out.push(none("ollama"));
    }
  }
  const codexEnabled = cfg?.providers?.codex?.enabled === true || cfg?.codex?.enabled === true;
  if (codexEnabled && _codex?.readUsage) {
    try {
      out.push(normalizeCodex(await _codex.readUsage({ config: cfg, usageOptIn: false })));
    } catch {
      out.push(none("codex", { source: "codex-app-server" }));
    }
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The reader's own clock, absolute (not "in 2 days") — no arithmetic between
// the printed digits and the provider's own site. Locale is pinned to en-GB's
// field order but month names are hand-rolled: ICU's own `month: "short"`
// renders "Sept", four letters, which this plugin's line shape does not use.
// The zone defaults to the host's; tests pin one so they never depend on the
// machine running them. Returns null (never throws) for a missing or
// unparseable instant — callers drop the whole "resets ..." clause.
export function formatResetTime(iso, { timeZone } = {}) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const month = MONTHS[Number(get("month")) - 1];
  return `${get("weekday")} ${Number(get("day"))} ${month}, ${get("hour")}:${get("minute")}`;
}

// `<provider> <kind>: <pct>% — resets <when>` — the line shape `quota` already
// printed for Anthropic, now every provider's.
export function usageLines(usages, { timeZone } = {}) {
  const lines = [];
  for (const u of usages) {
    for (const l of u.limits) {
      const scope = l.scope ? ` (${l.scope})` : "";
      const formatted = formatResetTime(l.resetsAt, { timeZone });
      const resets = formatted ? ` — resets ${formatted}` : "";
      lines.push(`${u.provider} ${l.kind}${scope}: ${l.percent}%${resets}`);
    }
  }
  return lines;
}

// The one place the provenance banner is worded. A reading that was NOT
// fetched by this process must be marked before any figure renders from it:
// `/!\` is deliberately not the house style — the advisory line this replaces
// (`usage unread for 33h`) was lost exactly because it looked like every
// other line. Returns [] for `live` and for readings with no provenance at
// all (Anthropic never gains one — its TTL cache self-heals — so its
// rendering is untouched), and for a `cached` reading with no recorded
// failure reason (the hook's plain cache read; the figure may be fresh from
// a successful fetch).
const REASON_TITLES = {
  "no-cookie": "No Cookie",
  "expired-cookie": "Cookie Expired",
  "network-error": "Network Error",
  timeout: "Fetch Timed Out",
  unparseable: "Page Unreadable",
};

export function provenanceBanner(usage) {
  if (!usage?.provenance || usage.provenance === "live" || !usage.reason) return [];
  const title = REASON_TITLES[usage.reason] ?? "Usage Unread";
  // Legacy headroom callers pass the raw Ollama reading before normalization.
  const provider = usage.provider || "ollama";
  const refresh = provider === "ollama"
    ? `    Refresh: swarm ollama-usage --cookie '<value>'${usage.cookiePath ? `   (writes ${usage.cookiePath})` : ""}`
    : `    Refresh: swarm usage --provider ${provider}`;
  if (usage.provenance === "cached") {
    const lastSeen = usage.lastSeen ? `  last seen: ${new Date(usage.lastSeen).toISOString()}` : "";
    return [`/!\\ ${title} — figures below are cached.${lastSeen}`, refresh];
  }
  return [`/!\\ ${title} — no cached reading available.`, refresh];
}

// What a session needs told WITHOUT being asked: a provider that cannot take
// work now, or a figure whose provenance is not this process's own fetch. A
// healthy — or live-fetched — provider adds nothing beyond its figures; the
// standing block is instruction, and unprompted noise beside it trains the
// reader to skip the whole thing.
export function notableLines(usages, { timeZone } = {}) {
  const lines = [];
  for (const u of usages) {
    lines.push(...provenanceBanner(u));
    if (u.state === "exhausted") {
      const weekly = u.limits.find((l) => l.kind === "weekly");
      const formatted = formatResetTime(weekly?.resetsAt, { timeZone });
      lines.push(`${u.provider}: weekly allowance exhausted${formatted ? `, resets ${formatted}` : ""}`);
      continue;
    }
    // A full session bar blocks dispatch RIGHT NOW even while the weekly verdict
    // is healthy, and it resets in hours rather than days — worth a line, not a
    // verdict change.
    const session = u.limits.find((l) => l.kind === "session");
    if (session && session.percent >= 100) {
      const formatted = formatResetTime(session.resetsAt, { timeZone });
      lines.push(`${u.provider}: session limit reached${formatted ? `, resets ${formatted}` : ""}`);
    }
  }
  return lines;
}
