// Anthropic subscription-quota awareness: classify "usage limit reached"
// failures (temporal, unlike transient rate limits), and preflight the OAuth
// usage endpoint with Claude Code's local credentials — free, predictive,
// strictly best-effort (any failure returns null; mid-run classification is
// the backstop).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_QUOTA_PATTERNS = [
  "usage limit reached",
  "out of extra usage",
  "hit your limit",
  "limit will reset",
];

export const DEFAULT_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export function matchQuota(text, patterns = DEFAULT_QUOTA_PATTERNS) {
  const t = String(text || "").toLowerCase();
  return patterns.some((p) => t.includes(p.toLowerCase()));
}

// "…limit reached|1751210400" -> ISO; "…will reset at 3pm (X)." -> "3pm (X)";
// "…resets at <ts>" -> "<ts>"; otherwise null.
export function parseQuotaReset(text) {
  const s = String(text || "");
  const epoch = s.match(/\|(\d{10})\b/);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();
  const human = s.match(/(?:will reset|resets?) at ([^\n.]+?)[.\s]*(?:$|\n)/i) || s.match(/(?:will reset|resets?) at ([^\n.]+)/i);
  if (human) return human[1].trim();
  return null;
}

// Endpoint response -> { limits, worst, exhausted, exhaustedScopes }. `limits[]`
// is the authoritative array (session/weekly/per-model-scoped, each with percent,
// severity, resets_at).
//
// A limit carrying a `scope.model` constrains THAT MODEL ONLY; an unscoped limit
// (session, weekly_all) is the account-wide truth. Conflating the two grounded
// every Claude leaf whenever one premium model's weekly bucket filled — while the
// account still had headroom and the dispatching session was itself running on a
// Claude model. So the account verdict reads unscoped limits, and each exhausted
// scope is reported separately for the caller to block just that model.
export function parseUsageLimits(json) {
  const limits = (json?.limits || []).map((l) => ({
    kind: l.kind,
    percent: l.percent ?? 0,
    severity: l.severity,
    resetsAt: l.resets_at ?? null,
    scope: l.scope?.model?.display_name ?? null,
  }));
  if (!limits.length) return null;
  const unscoped = limits.filter((l) => !l.scope);
  // No unscoped limit reported → fall back to the whole set rather than claim
  // infinite headroom.
  const worst = (unscoped.length ? unscoped : limits).reduce((a, b) => (b.percent > a.percent ? b : a));
  const exhaustedScopes = limits
    .filter((l) => l.scope && l.percent >= 100)
    .map((l) => ({ scope: l.scope, percent: l.percent, resetsAt: l.resetsAt }));
  return { limits, worst, exhausted: worst.percent >= 100, exhaustedScopes };
}

function readOAuthToken(credentialsPath) {
  try {
    return JSON.parse(readFileSync(credentialsPath, "utf8"))?.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

export async function fetchUsageLimits({ fetch, url = DEFAULT_USAGE_URL, credentialsPath }) {
  const token = readOAuthToken(credentialsPath);
  if (!token) return null;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    });
    if (!res.ok) return null;
    return parseUsageLimits(await res.json());
  } catch {
    return null;
  }
}

// Cached best-effort quota check. Cache lives under the swarm home so repeated
// runs (and the `quota` subcommand) within TTL don't re-query.
export async function checkQuota({
  cfg = {},
  fetch,
  credentialsPath = join(homedir(), ".claude", ".credentials.json"),
  cachePath,
  now = () => Date.now(),
}) {
  const ttlMs = (cfg.quotaCacheSecs ?? 300) * 1000;
  if (cachePath && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8"));
      if (now() - cached.ts < ttlMs && cached.result) return { ...cached.result, source: "cache" };
    } catch { /* corrupt cache — refetch */ }
  }
  const parsed = await fetchUsageLimits({ fetch, url: cfg.quotaUsageUrl || DEFAULT_USAGE_URL, credentialsPath });
  if (!parsed) return null;
  if (cachePath) {
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ ts: now(), result: parsed }));
    } catch { /* cache is garnish */ }
  }
  return { ...parsed, source: "endpoint" };
}
