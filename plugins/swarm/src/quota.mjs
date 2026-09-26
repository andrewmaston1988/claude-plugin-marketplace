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

// "…reached your <weekly|session> usage limit, add extra usage: ollama.com/settings" —
// keyed on the suffix so a later meter needs no edit. Deliberately NOT in `quotaPatterns`:
// that list is the operator's to narrow, and `config init` never adds to an already-set key.
const PROVIDER_QUOTA_PATTERNS = ["usage limit, add extra usage"];

export function matchQuota(text, patterns = DEFAULT_QUOTA_PATTERNS) {
  const t = String(text || "").toLowerCase();
  return [...patterns, ...PROVIDER_QUOTA_PATTERNS].some((p) => t.includes(p.toLowerCase()));
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

export async function fetchUsageLimits({ fetch, url = DEFAULT_USAGE_URL, credentialsPath, onRetryAfter }) {
  const token = readOAuthToken(credentialsPath);
  if (!token) return null;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    });
    if (!res.ok) {
      const secs = Number(res.headers?.get?.("retry-after"));
      if (secs > 0) onRetryAfter?.(secs * 1000);
      return null;
    }
    return parseUsageLimits(await res.json());
  } catch {
    return null;
  }
}

// The last good reading, re-read at `nowMs`: a bucket whose reset has passed has
// refilled, so it reads 0% rather than its stale fill (which could ground dispatch).
function staleReading(cached, nowMs) {
  const limits = cached.result.limits.map((l) => ({
    kind: l.kind, severity: l.severity, resets_at: l.resetsAt,
    percent: l.resetsAt && Date.parse(l.resetsAt) <= nowMs ? 0 : l.percent,
    scope: l.scope ? { model: { display_name: l.scope } } : null,
  }));
  return { ...parseUsageLimits({ limits }), source: "stale", asOfMs: cached.ts };
}

function writeCache(cachePath, entry) {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(entry));
  } catch { /* cache is garnish */ }
}

// Cached best-effort quota check. Cache lives under the swarm home so repeated
// runs (and the `quota` subcommand) within TTL don't re-query. A refused fetch
// serves the last good reading (source "stale"), and a Retry-After is honoured —
// asking again sooner only extends the endpoint's rate limit.
export async function checkQuota({
  cfg = {},
  fetch,
  credentialsPath = join(homedir(), ".claude", ".credentials.json"),
  cachePath,
  now = () => Date.now(),
}) {
  const ttlMs = (cfg.quotaCacheSecs ?? 300) * 1000;
  let cached = null;
  if (cachePath && existsSync(cachePath)) {
    try { cached = JSON.parse(readFileSync(cachePath, "utf8")); } catch { /* corrupt cache — refetch */ }
  }
  if (cached?.result && now() - cached.ts < ttlMs) return { ...cached.result, source: "cache" };
  const stale = () => (cached?.result?.limits?.length ? staleReading(cached, now()) : null);
  if (cached?.retryAfter > now()) return stale();
  let retryMs = 0;
  const parsed = await fetchUsageLimits({ fetch, url: cfg.quotaUsageUrl || DEFAULT_USAGE_URL, credentialsPath, onRetryAfter: (ms) => { retryMs = ms; } });
  if (!parsed) {
    if (retryMs && cachePath) writeCache(cachePath, { ...cached, retryAfter: now() + retryMs });
    return stale();
  }
  if (cachePath) writeCache(cachePath, { ts: now(), result: parsed });
  return { ...parsed, source: "endpoint" };
}

// The `quota` subcommand's whole body, here rather than in the arg dispatcher so
// the reporting rules sit beside the fetch they report on. Anthropic is fetched
// (its credential renews itself); every cloud provider is read from cache,
// because its cookie — or, for Codex, an app-server process — needs a cost this
// command must not pay. All of them print through `usageLines`, the same path
// the standing-mode hook uses, so the two can never word a reading differently.
// Returns the exit code: Anthropic exhausted, and nothing else.
export async function printQuota({ cfg, out, cachePath, credentialsPath, fetchImpl = globalThis.fetch }) {
  const { providerConfig } = await import("./providers.mjs");
  const { normalizeAnthropic, normalizeOllama, normalizeCodex, codexUsageFromCache, usageLines, notableLines } =
    await import("./usage.mjs");

  const q = await checkQuota({
    cfg,
    fetch: (...a) => fetchImpl(...a),
    cachePath,
    ...(credentialsPath && { credentialsPath }),
  });
  const usages = [];
  if (q) usages.push(normalizeAnthropic(q));
  else out("anthropic: unavailable (no Claude Code credentials, or the usage endpoint did not respond)");

  const { usageFromCache, ollamaCloudConfig } = await import("./ollama-usage.mjs");
  if (ollamaCloudConfig(cfg).enabled === true) {
    const reading = usageFromCache(cfg);
    if (reading.state === "unknown") out("ollama: no reading yet — run `swarm ollama-usage --cookie '<value>'`");
    else usages.push(normalizeOllama(reading));
  }

  // Codex on the same terms as Ollama, and for a stronger reason: its reading
  // costs an app-server process, so the figure comes from the cache `swarm
  // usage` banked — this command never spawns one.
  if (providerConfig(cfg, "codex").enabled === true) {
    const cached = codexUsageFromCache();
    if (cached) usages.push(normalizeCodex(cached));
    else out("codex: no cached reading yet — run `swarm usage --provider codex`");
  }

  for (const line of usageLines(usages)) out(line);
  // Anthropic severity is its own vocabulary and has no cross-provider
  // equivalent, so it stays an Anthropic-only annotation.
  for (const l of q?.limits || []) {
    if (l.severity && l.severity !== "normal") out(`anthropic ${l.kind}: [${l.severity}]`);
  }
  for (const line of notableLines(usages)) out(line);
  // Exit code keeps its documented meaning: Anthropic exhausted. A cloud
  // provider's state is reported, never conflated with it.
  return q?.exhausted ? 1 : 0;
}
