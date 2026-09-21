// The Claude adapter's usage surface: `checkQuota`'s reading wrapped into the
// canonical ProviderUsageSnapshot every other provider's readUsage returns.
//
// Two modes, one function. `usageOptIn: true` (the `quota` subcommand, the
// scheduler's providerUsage gate) reads live — checkQuota's TTL cache or a
// fresh endpoint fetch; anything else (the standing hook, `swarm usage`) must
// never fetch and reads only the TTL file the CLI refills. Exhaustion is not
// recomputed here: `parseUsageLimits` already owns the unscoped-only account
// verdict, and this wrapper carries it through untouched.
import { join } from "node:path";
import { checkQuota } from "./quota.mjs";
import { providerUsageSnapshot } from "./contracts.mjs";
import { swarmHome } from "./config.mjs";
import { readAnthropicCacheResult } from "./usage.mjs";

const SOURCE = "anthropic-oauth-usage";

// A read that could not answer. `reason` is set only when someone asked for the
// reading and it failed anyway (live mode) — hook mode stays reason-less
// because the CLI refills that cache unprompted and a banner would be noise.
function marked(reason, asOf) {
  return providerUsageSnapshot({
    provider: "claude",
    buckets: reason ? [{ kind: "unavailable", reason }] : [],
    source: SOURCE,
    provenance: "none",
    ...(reason ? { reason } : {}),
    asOf,
  });
}

function claudeSnapshot(parsed, provenance, asOf) {
  return providerUsageSnapshot({
    provider: "claude",
    buckets: (parsed.limits || []).map((l) => ({
      kind: l.kind || "usage",
      percent: l.percent,
      resetsAt: l.resetsAt ?? null,
      ...(l.scope ? { scope: l.scope } : {}),
    })),
    source: SOURCE,
    provenance,
    exhausted: parsed.exhausted === true,
    asOf,
  });
}

// Callers hand `now` in both conventions: a NUMBER (readCachedUsage's walk) or
// a FUNCTION (the scheduler's io). checkQuota wants the function; the TTL
// compare wants the number. One read, so freezing at entry is fine.
export async function readClaudeUsage(context = {}) {
  const cfg = context.config || context.cfg || {};
  const env = context.env || process.env;
  const raw = context.now;
  const nowMs = typeof raw === "function" ? raw() : (typeof raw === "number" ? raw : Date.now());
  const cachePath = context.cachePath || join(swarmHome(env), "quota-cache.json");

  if (context.usageOptIn !== true) {
    const fresh = readAnthropicCacheResult(cfg, nowMs, cachePath);
    if (!fresh || !fresh.parsed?.limits?.length) return marked(null, new Date(nowMs).toISOString());
    return claudeSnapshot(fresh.parsed, "cache", new Date(fresh.asOf).toISOString());
  }

  const q = await (context.quotaCheck || checkQuota)({
    cfg,
    fetch: context.fetch,
    credentialsPath: env?.SWARM_CREDENTIALS,
    cachePath,
    now: () => nowMs,
  });
  if (!q || !q.limits?.length) {
    return marked("anthropic usage endpoint unreachable, or no Claude Code credentials", new Date(nowMs).toISOString());
  }
  const provenance = q.source === "cache" ? "cache" : q.source === "endpoint" ? "live" : "unknown";
  return claudeSnapshot(q, provenance, new Date(nowMs).toISOString());
}