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

// Pure over `readUsage`'s output.
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
    ...(reading.snapshotAgeMs !== undefined && { snapshotAgeMs: reading.snapshotAgeMs }),
  };
}

// Anthropic's cache is a TTL cache the CLI refills on demand, so an EXPIRED one
// is `unknown`, never `stale`: the next `quota` call refreshes it unprompted and
// a staleness warning would be noise the reader can do nothing about. Ollama is
// the opposite — its credential is a browser cookie a human pastes in, so an old
// snapshot ages into `stale` and SAYS SO. That asymmetry is real; flattening it
// would either spam a warning Anthropic fixes silently, or bury one only the
// operator can fix.
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

// `<provider> <kind>: <pct>% — resets <when>` — the line shape `quota` already
// printed for Anthropic, now every provider's.
export function usageLines(usages) {
  const lines = [];
  for (const u of usages) {
    for (const l of u.limits) {
      const scope = l.scope ? ` (${l.scope})` : "";
      const resets = l.resetsAt ? ` — resets ${l.resetsAt}` : "";
      lines.push(`${u.provider} ${l.kind}${scope}: ${l.percent}%${resets}`);
    }
  }
  return lines;
}

// What a session needs told WITHOUT being asked: a provider that cannot take
// work now, or a reading too old to trust. A healthy provider says nothing — the
// standing block is instruction, and unprompted noise beside it trains the
// reader to skip the whole thing.
export function notableLines(usages) {
  const lines = [];
  for (const u of usages) {
    if (u.state === "exhausted") {
      const weekly = u.limits.find((l) => l.kind === "weekly");
      lines.push(`${u.provider}: weekly allowance exhausted${weekly?.resetsAt ? `, resets ${weekly.resetsAt}` : ""}`);
      continue;
    }
    if (u.state === "stale") {
      lines.push(`${u.provider}: usage unread for ${Math.floor((u.snapshotAgeMs ?? 0) / 3_600_000)}h`);
      continue;
    }
    // A full session bar blocks dispatch RIGHT NOW even while the weekly verdict
    // is healthy, and it resets in hours rather than days — worth a line, not a
    // verdict change.
    const session = u.limits.find((l) => l.kind === "session");
    if (session && session.percent >= 100) {
      lines.push(`${u.provider}: session limit reached${session.resetsAt ? `, resets ${session.resetsAt}` : ""}`);
    }
  }
  return lines;
}
