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

export const QUOTA_CACHE_FILENAME = "quota-cache.json";

// A limit window, uniform across providers. `scope` is Anthropic's per-model
// bucket; cloud providers have no equivalent and leave it null.
function limit(kind, percent, resetsAt, scope = null) {
  return { kind, percent, resetsAt: resetsAt ?? null, scope };
}

const none = (provider) => ({ provider, state: "unknown", limits: [] });

// Pure over `parseUsageLimits`'s output (the `result` half of the quota cache,
// or a fresh fetch).
export function normalizeAnthropic(parsed) {
  if (!parsed?.limits?.length) return none("anthropic");
  return {
    provider: "anthropic",
    state: parsed.exhausted ? "exhausted" : "ok",
    limits: parsed.limits.map((l) => limit(l.kind, l.percent, l.resetsAt, l.scope ?? null)),
  };
}

// Pure over `readUsage`'s output. Provenance fields ride through so the
// banner can be worded from the SAME shape every consumer holds.
export function normalizeOllama(reading) {
  if (!reading || reading.state === "unknown") return none("ollama");
  const limits = [];
  if (typeof reading.sessionPctUsed === "number") {
    limits.push(limit("session", reading.sessionPctUsed, reading.sessionResetsAt));
  }
  if (typeof reading.weeklyPctUsed === "number") {
    limits.push(limit("weekly", reading.weeklyPctUsed, reading.resetsAt ?? reading.weeklyResetsAt));
  }
  return {
    provider: "ollama",
    state: reading.state,
    limits,
    ...(reading.provenance !== undefined && { provenance: reading.provenance }),
    ...(reading.reason != null && { reason: reading.reason }),
    ...(reading.lastSeen != null && { lastSeen: reading.lastSeen }),
    ...(reading.cookiePath != null && { cookiePath: reading.cookiePath }),
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
  return normalizeAnthropic(cached.result);
}

// Every provider, in one array, cache-only. Callers that can afford a fetch (the
// `quota` subcommand) fetch first and normalize the fresher reading themselves.
export async function readCachedUsage(cfg = {}, { env = process.env, now = Date.now(), cachePath, _ollama } = {}) {
  const out = [readAnthropicCache(cfg, now, cachePath)];
  if (cfg?.provider?.cloud?.ollama?.enabled === true) {
    const { usageFromCache } = _ollama || (await import("./ollama-usage.mjs"));
    try {
      out.push(normalizeOllama(usageFromCache(cfg, env)));
    } catch {
      out.push(none("ollama"));
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
  const refresh = `    Refresh: swarm ollama-usage --cookie '<value>'${usage.cookiePath ? `   (writes ${usage.cookiePath})` : ""}`;
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
