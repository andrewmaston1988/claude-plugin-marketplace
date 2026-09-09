// Swarm's own ollama.com cloud-usage preflight — mirrors src/quota.mjs's role for
// Anthropic. Fetch, parse and cache are all here, node:* only, so the plugin
// carries zero npm dependencies. This does NOT read the operator's private
// `<claude-base>/skills/ollama-usage` tooling or its files in any way — same
// upstream page, independent fetch, independent cache, for a different question
// (can I dispatch right now, not what did each model cost across weeks).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { swarmHome } from "./config.mjs";
import { parseHtml } from "./minidom.mjs";
import { appendSnapshot, usageHistoryPath } from "./cost.mjs";

export const SETTINGS_URL = "https://ollama.com/settings"; // like quota.mjs's DEFAULT_USAGE_URL

const USAGE_CACHE_FILENAME = "ollama-usage.json";
const DEFAULT_TIMEOUT_MS = 5000;

export function usageCachePath(env = process.env) {
  return join(swarmHome(env), USAGE_CACHE_FILENAME);
}

// The browser-cookie credential lives in its own file, never in config.json —
// config.json is read/printed/diffed constantly and a session cookie in it
// would end up in a transcript.
export function saveCookie(cookiePath, value) {
  mkdirSync(dirname(cookiePath), { recursive: true });
  writeFileSync(cookiePath, String(value).trim() + "\n", "utf8");
}

export function loadCookie(cookiePath) {
  try {
    if (!cookiePath || !existsSync(cookiePath)) return null;
    return readFileSync(cookiePath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

// Find `aria-label="<label> ...% used"` and read the percentage from INSIDE
// that matched attribute value — never from a document-wide scan, so two bars
// with different labels can never be confused for each other.
function findLabelPct(html, label) {
  const needle = `aria-label="${label} `;
  const start = html.indexOf(needle);
  if (start === -1) return null;
  const valueStart = start + 'aria-label="'.length;
  const valueEnd = html.indexOf('"', valueStart);
  if (valueEnd === -1) return null;
  const value = html.slice(valueStart, valueEnd);
  const m = value.match(/([\d.]+)%\s*used/);
  if (!m) return null;
  return { pctUsed: Number(m[1]), labelEnd: valueEnd };
}

// The reset time is the NEXT `data-time="…"` occurrence after the label's own
// index — the markup emits the reset line immediately after its bar. This is
// the one real assumption in the whole parse (see plan: P1/P4 hold it).
function findNextDataTime(html, fromIndex) {
  const needle = 'data-time="';
  const start = html.indexOf(needle, fromIndex);
  if (start === -1) return null;
  const valueStart = start + needle.length;
  const valueEnd = html.indexOf('"', valueStart);
  if (valueEnd === -1) return null;
  return html.slice(valueStart, valueEnd);
}

// width: N% from a style attribute — the ONLY source of meterSharePct. A
// segment without a presentational width carries no share information.
function widthPct(style) {
  const m = /(?:^|;)\s*width:\s*([\d.]+)%/.exec(style || "");
  return m ? Number(m[1]) : null;
}

// The per-model segments of one usage bar, scoped to that bar's subtree — a
// flat document-wide scan cannot tell which bar a segment belongs to once the
// page nests them. Malformed segments (missing model, requests or width) are
// dropped from the list.
function barSegments(bar) {
  return bar.querySelectorAll('[data-usage-segment]')
    .map((el) => {
      const req = el.getAttribute("data-requests");
      return {
        model: el.getAttribute("data-model"),
        requests: req != null && req !== "" ? Number(req) : null,
        meterSharePct: widthPct(el.getAttribute("style")),
      };
    })
    .filter((s) => typeof s.model === "string" && s.model && Number.isFinite(s.requests) && s.meterSharePct != null);
}

// meterSharePct comes from presentational `style="width: N%"` attributes. The
// page emits them summing to 100 per bar (± rounding); any other total means
// the layout changed shape and the widths are not shares of anything — the
// bar's segment list is rejected as unmeasured, never scaled to fit.
export function segmentsSumTo100(models, tol = 0.5) {
  if (!models?.length) return false;
  const sum = models.reduce((acc, m) => acc + (m.meterSharePct ?? 0), 0);
  return Math.abs(sum - 100) <= tol;
}

// Pure over the fetched HTML. The two bar reads are indexOf walks over bounded
// slices (findLabelPct/findNextDataTime); only the per-model segment lists need
// the element tree. Any anchor missing => the whole reading is unknown, never
// partial: a wrong meter reading is worse than none.
export function parseUsage(html) {
  const text = String(html || "");
  const session = findLabelPct(text, "Session usage");
  const weekly = findLabelPct(text, "Weekly usage");
  if (!session || !weekly) return { state: "unknown" };

  const sessionResetsAt = findNextDataTime(text, session.labelEnd);
  const weeklyResetsAt = findNextDataTime(text, weekly.labelEnd);
  if (!sessionResetsAt || !weeklyResetsAt) return { state: "unknown" };

  const doc = parseHtml(text);
  const bars = doc.querySelectorAll("[aria-label]");
  const segmentsOf = (label) => {
    const bar = bars.find((el) => (el.getAttribute("aria-label") || "").startsWith(label + " "));
    if (!bar) return [];
    const segs = barSegments(bar);
    // a bar whose widths don't total 100 is a layout variant, not a measurement
    return segmentsSumTo100(segs) ? segs : [];
  };

  return {
    sessionPctUsed: session.pctUsed,
    sessionResetsAt,
    weeklyPctUsed: weekly.pctUsed,
    weeklyResetsAt,
    sessionModels: segmentsOf("Session usage"),
    weeklyModels: segmentsOf("Weekly usage"),
  };
}

// Fetch with the configured cookie. Returns the parsed reading, or an outcome
// describing why there isn't one. `cachePath` is optional and is written ONLY
// on success — a failed fetch (the ordinary case: an expired cookie) must age
// the existing snapshot rather than re-stamp it, so the failure branches below
// touch the filesystem only through recordUsageError's lastError note.
// `timeoutMs` bounds the fetch with an AbortSignal so a hung ollama.com cannot
// wedge a caller; a signal-blind injected _fetch is still bounded by the race.
export async function fetchUsage({ cookie, cachePath, url = SETTINGS_URL, _fetch = fetch, _now = Date.now, timeoutMs } = {}) {
  if (!cookie) return { ok: false, reason: "no-cookie" };

  const controller = new AbortController();
  let timer = null;
  let res;
  try {
    const opts = { redirect: "manual", headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0" }, signal: controller.signal };
    res = await (timeoutMs
      ? Promise.race([
          _fetch(url, opts),
          new Promise((_, rej) => {
            timer = setTimeout(() => { controller.abort(); rej(new Error("usage-timeout")); }, timeoutMs);
          }),
        ])
      : _fetch(url, opts));
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "network-error" };
  } finally {
    if (timer) clearTimeout(timer);
  }

  const location = typeof res.headers?.get === "function" ? res.headers.get("location") : null;
  const body = typeof res.text === "function" ? await res.text() : "";
  const looksExpired =
    res.status === 303 ||
    res.status === 302 ||
    (location && location.includes("/signin")) ||
    !body.includes("data-usage-track");
  if (looksExpired) return { ok: false, reason: "expired-cookie" };

  const parsed = parseUsage(body);
  if (parsed.state === "unknown") return { ok: false, reason: "unparseable" };

  const reading = { ...parsed, fetchedAt: _now() };
  if (cachePath) {
    mkdirSync(dirname(cachePath), { recursive: true });
    // The cache stays headroom-shaped: per-model segments are stripped, so the
    // provenance path is byte-identical to before the fields existed.
    const { sessionModels, weeklyModels, ...headroom } = reading;
    writeFileSync(cachePath, JSON.stringify(headroom));
  }
  return { ok: true, ...reading };
}

// Pure over the cache object. No filesystem, no age. A cached 100% still reads
// `exhausted` — but what acts on that verdict is the reading's PROVENANCE,
// attached by getUsage/usageFromCache, not this classifier: a cached reading
// may describe a window that has since reset, so only a live one may fail a
// dispatch. Age survives only as the `lastSeen` display field.
export function readUsage(cacheText, { now = Date.now() } = {}) {
  let cached;
  try {
    cached = JSON.parse(cacheText);
  } catch {
    return { state: "unknown" };
  }
  if (!cached || typeof cached.weeklyPctUsed !== "number" || !cached.fetchedAt) {
    return { state: "unknown" };
  }

  const resetsAt = cached.weeklyResetsAt ?? null;
  // Session rides along on every reading. The VERDICT stays weekly-driven — a
  // full session bar clears in hours, a full week does not — but a caller
  // deciding "can I dispatch right now" needs to see both, and the fetch has
  // always cached both.
  const session = typeof cached.sessionPctUsed === "number"
    ? { sessionPctUsed: cached.sessionPctUsed, sessionResetsAt: cached.sessionResetsAt ?? null }
    : {};
  if (cached.weeklyPctUsed >= 100) {
    return { state: "exhausted", weeklyPctUsed: cached.weeklyPctUsed, resetsAt, ...session };
  }
  return { state: "ok", weeklyPctUsed: cached.weeklyPctUsed, resetsAt, ...session };
}

// Record a failed fetch beside the reading, WITHOUT touching the reading's own
// fields — `fetchedAt` keeps its value, so a cached figure never looks fresher
// than it is. Only an existing cache file gains the note: the consumers of
// `lastError` (the hook, `quota`) read it back WITH a figure to mark; where no
// reading exists there is nothing to mark. Best-effort, never throws.
export function recordUsageError(cachePath, reason, at = Date.now()) {
  try {
    if (!existsSync(cachePath)) return;
    let cached = {};
    try { cached = JSON.parse(readFileSync(cachePath, "utf8")) || {}; } catch { return; }
    if (typeof cached !== "object" || Array.isArray(cached)) return;
    writeFileSync(cachePath, JSON.stringify({ ...cached, lastError: reason, lastErrorAt: at }));
  } catch { /* best effort */ }
}

// One reading per process, memoised across callers — checkHeadroom runs per
// `:cloud` seat, so a five-seat manifest must issue one request, failed or
// not. The memo dies with the process: never a TTL, never a file, or it
// becomes a second cache with no provenance. Tests reset it via
// resetUsageMemo(); a fresh module import re-fetches by construction.
let memo = null;
export function resetUsageMemo() {
  memo = null;
}

// The single entry point callers that CAN afford a fetch use. Attempts the
// live fetch; on success returns the cache-read-back reading with
// `provenance: "live"`; on failure returns the cached reading as
// `{ provenance: "cached", reason, lastSeen, cookiePath }`, or
// `{ provenance: "none", reason }` when there is no cache either. `gate`
// mirrors usageFromCache's enabled-check; the `ollama-usage` subcommand passes
// `gate: false` because fetching is that subcommand's job even before ollama
// is enabled. Absent config => `{ state: "unknown" }`: a user who has never
// heard of ollama must meet nothing, not an error.
export async function getUsage(cfg, { env = process.env, _fetch = fetch, _now = Date.now, gate = true } = {}) {
  if (memo) return memo;
  memo = await computeUsage(cfg, { env, _fetch, _now, gate });
  return memo;
}

async function computeUsage(cfg, { env, _fetch, _now, gate }) {
  if (gate && cfg?.provider?.cloud?.ollama?.enabled !== true) return { state: "unknown" };

  const cookiePath = cfg?.provider?.cloud?.ollama?.cookiePath || join(swarmHome(env), "ollama-cookie.json");
  const cachePath = usageCachePath(env);
  const fetched = await fetchUsage({
    cookie: loadCookie(cookiePath),
    cachePath,
    url: cfg?.provider?.cloud?.ollama?.settingsUrl || SETTINGS_URL,
    _fetch,
    _now,
    timeoutMs: cfg?.provider?.usageTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  // One classifier for both provenances: the just-written cache is read back
  // through the same readUsage a cached reading goes through, so a fresh 100%
  // and a cached 100% can never disagree about being exhausted.
  if (fetched.ok) {
    // Bank the week's snapshot for `swarm cost`. Deliberately from the fetch's
    // RETURN (which carries the segments) — the cache on disk strips them.
    // Best-effort: a failed history write must not fail a dispatch that has a
    // perfectly good headroom reading.
    try {
      if (fetched.weeklyModels?.length) {
        appendSnapshot({
          fetchedAt: fetched.fetchedAt,
          weeklyPctUsed: fetched.weeklyPctUsed,
          weeklyResetsAt: fetched.weeklyResetsAt,
          weeklyModels: fetched.weeklyModels,
        }, usageHistoryPath(env));
      }
    } catch { /* headroom still valid */ }
    let text;
    try {
      text = readFileSync(cachePath, "utf8");
    } catch {
      return { state: "unknown", provenance: "live" };
    }
    return { ...readUsage(text), provenance: "live" };
  }

  recordUsageError(cachePath, fetched.reason, _now());
  let text = null;
  let cached = null;
  try {
    text = readFileSync(cachePath, "utf8");
    cached = JSON.parse(text);
  } catch { /* no cache, or not JSON: provenance none */ }
  const reading = cached ? readUsage(text) : { state: "unknown" };
  if (reading.state === "unknown") {
    return { state: "unknown", provenance: "none", reason: fetched.reason, cookiePath };
  }
  return {
    ...reading,
    provenance: "cached",
    reason: fetched.reason,
    lastSeen: cached.fetchedAt ?? null,
    cookiePath,
  };
}

// The cache-only reader (hook, `quota`): same provenance vocabulary as
// getUsage, minus a fetch. The recorded `lastError` supplies the reason — the
// hook cannot fetch, so it reports what the last fetching command stored.
// Never throws. Absent config => absent feature.
export function usageFromCache(cfg, env = process.env) {
  if (cfg?.provider?.cloud?.ollama?.enabled !== true) return { state: "unknown" };

  let text;
  try {
    text = readFileSync(usageCachePath(env), "utf8");
  } catch {
    return { state: "unknown" };
  }
  let cached;
  try {
    cached = JSON.parse(text);
  } catch {
    return { state: "unknown" };
  }
  const reading = readUsage(text);
  if (reading.state === "unknown") return reading;
  return {
    ...reading,
    provenance: "cached",
    reason: cached.lastError ?? null,
    lastSeen: cached.fetchedAt ?? null,
    cookiePath: cfg?.provider?.cloud?.ollama?.cookiePath || join(swarmHome(env), "ollama-cookie.json"),
  };
}
