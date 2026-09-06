// Swarm's own ollama.com cloud-usage preflight — mirrors src/quota.mjs's role for
// Anthropic. Fetch, parse and cache are all here, node:* only, so the plugin
// carries zero npm dependencies. This does NOT read the operator's private
// `<claude-base>/skills/ollama-usage` tooling or its files in any way — same
// upstream page, independent fetch, independent cache, for a different question
// (can I dispatch right now, not what did each model cost across weeks).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { swarmHome } from "./config.mjs";

export const SETTINGS_URL = "https://ollama.com/settings"; // like quota.mjs's DEFAULT_USAGE_URL

const USAGE_CACHE_FILENAME = "ollama-usage.json";
const DEFAULT_STALE_MS = 86_400_000;

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

// Pure over the fetched HTML. Two indexOf walks over bounded slices — no DOM,
// no character-window heuristics (the upstream regex-over-text version broke
// twice on layout growth doing exactly that). Any anchor missing => the whole
// reading is unknown, never partial: a wrong meter reading is worse than none.
export function parseUsage(html) {
  const text = String(html || "");
  const session = findLabelPct(text, "Session usage");
  const weekly = findLabelPct(text, "Weekly usage");
  if (!session || !weekly) return { state: "unknown" };

  const sessionResetsAt = findNextDataTime(text, session.labelEnd);
  const weeklyResetsAt = findNextDataTime(text, weekly.labelEnd);
  if (!sessionResetsAt || !weeklyResetsAt) return { state: "unknown" };

  return {
    sessionPctUsed: session.pctUsed,
    sessionResetsAt,
    weeklyPctUsed: weekly.pctUsed,
    weeklyResetsAt,
  };
}

// Fetch with the configured cookie. Returns the parsed reading, or an outcome
// describing why there isn't one. `cachePath` is optional and is written ONLY
// on success — a silently expired cookie (the ordinary failure here) must age
// the existing snapshot into `stale`, never re-stamp it, so every failure
// branch below returns before touching the filesystem.
export async function fetchUsage({ cookie, cachePath, _fetch = fetch, _now = Date.now } = {}) {
  if (!cookie) return { ok: false, reason: "no-cookie" };

  let res;
  try {
    res = await _fetch(SETTINGS_URL, {
      redirect: "manual",
      headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0" },
    });
  } catch {
    return { ok: false, reason: "network-error" };
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
    writeFileSync(cachePath, JSON.stringify(reading));
  }
  return { ok: true, ...reading };
}

// Pure over the cache object + now. No filesystem. Order matters: stale is
// checked BEFORE exhausted, so a week-old reading of 100 reports `stale`, not
// `exhausted` — the meter resets weekly and an old reading proves nothing now.
export function readUsage(cacheText, { now = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
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
  const snapshotAgeMs = now - cached.fetchedAt;
  if (snapshotAgeMs >= staleMs) {
    return { state: "stale", snapshotAgeMs, weeklyPctUsed: cached.weeklyPctUsed, resetsAt };
  }
  if (cached.weeklyPctUsed >= 100) {
    return { state: "exhausted", weeklyPctUsed: cached.weeklyPctUsed, resetsAt };
  }
  return { state: "ok", weeklyPctUsed: cached.weeklyPctUsed, resetsAt };
}

// The file read + the "is this provider even enabled" check. Never throws.
// Absent config => absent feature: a user who has never heard of ollama must
// meet nothing, not an error.
export function usageFromCache(cfg, env = process.env) {
  if (cfg?.provider?.cloud?.ollama?.enabled !== true) return { state: "unknown" };

  let text;
  try {
    text = readFileSync(usageCachePath(env), "utf8");
  } catch {
    return { state: "unknown" };
  }

  const staleMs = cfg?.provider?.usageStaleMs ?? DEFAULT_STALE_MS;
  return readUsage(text, { staleMs });
}
