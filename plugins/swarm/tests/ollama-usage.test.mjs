import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SETTINGS_URL, fetchUsage, parseUsage, readUsage, usageFromCache, usageCachePath,
  saveCookie, loadCookie, getUsage,
} from "../src/ollama-usage.mjs";
import { parseHtml } from "../src/minidom.mjs";
import { usageHistoryPath, readSnapshots } from "../src/cost.mjs";
import { initConfig } from "../src/config.mjs";

const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures", "ollama-settings.html"), "utf8");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "swarm-ollama-usage-"));
}

const cfgEnabled = (extra = {}) => ({ provider: { cloud: { ollama: { enabled: true, ...extra } } } });
// Far past every real clock, so a reading written at FIFTY is unambiguous.
const FIFTY = 2_000_000_000_000;
const SIX_MIN = 6 * 60_000; // one minute past the 5-minute TTL

// ---- H1-H6: readUsage / usageFromCache classification --------------------

test("readUsage: H1 exhausted — a fresh 100% reading", () => {
  const now = 2_000_000_000_000;
  const cache = JSON.stringify({ weeklyPctUsed: 100, weeklyResetsAt: "2026-09-07T00:00:00Z", fetchedAt: now - 3_600_000 });
  deepEqual(readUsage(cache, { now }), { state: "exhausted", weeklyPctUsed: 100, resetsAt: "2026-09-07T00:00:00Z" });
});

test("readUsage: H2 ok — a real reading below 100", () => {
  const now = 2_000_000_000_000;
  const cache = JSON.stringify({ weeklyPctUsed: 83.8, weeklyResetsAt: "2026-09-12T08:00:00Z", fetchedAt: now - 3_600_000 });
  equal(readUsage(cache, { now }).state, "ok");
});

test("readUsage: H3 a week-old 100% still reads exhausted — provenance, not age, is what gates", () => {
  const now = 2_000_000_000_000;
  const cache = JSON.stringify({ weeklyPctUsed: 100, weeklyResetsAt: "R", fetchedAt: now - 7 * 86_400_000 });
  equal(readUsage(cache, { now }).state, "exhausted");
  // The protection the old stale branch carried now lives in the provenance
  // layer: only a LIVE exhausted reading may fail a dispatch. See getUsage
  // tests below (provenance cached/none never reach checkHeadroom as errors).
});

test("readUsage: H4 unknown — empty, whitespace, unparseable, or missing weeklyPctUsed, never throws", () => {
  for (const text of ["", "   ", "{not json", JSON.stringify({ foo: "bar" })]) {
    deepEqual(readUsage(text, { now: 0 }), { state: "unknown" });
  }
});

test("readUsage: H5 boundaries — 99.9 ok / 100 exhausted, regardless of age", () => {
  const now = 2_000_000_000_000;
  const fresh = { weeklyResetsAt: "R", fetchedAt: now - 1000 };
  equal(readUsage(JSON.stringify({ ...fresh, weeklyPctUsed: 99.9 }), { now }).state, "ok");
  equal(readUsage(JSON.stringify({ ...fresh, weeklyPctUsed: 100 }), { now }).state, "exhausted");

  const old = JSON.stringify({ weeklyPctUsed: 50, weeklyResetsAt: "R", fetchedAt: now - 30 * 86_400_000 });
  equal(readUsage(old, { now }).state, "ok", "age is a display field now, not a classification");
});

test("usageFromCache: H6 never throws — missing path, or the path is a directory", () => {
  const home = tempHome();
  try {
    const cfg = { provider: { cloud: { ollama: { enabled: true } } } };
    deepEqual(usageFromCache(cfg, { SWARM_HOME: home }), { state: "unknown" });

    const cachePath = usageCachePath({ SWARM_HOME: home });
    mkdirSync(cachePath, { recursive: true });
    deepEqual(usageFromCache(cfg, { SWARM_HOME: home }), { state: "unknown" });
    rmSync(cachePath, { recursive: true, force: true });

    // Best-effort: a file the owner cannot read. Windows ACLs don't reliably
    // deny the owner's own read via chmod bits, so this only asserts when the
    // permission change actually took — the directory case above already
    // proves the never-throw contract on every platform.
    writeFileSync(cachePath, JSON.stringify({ weeklyPctUsed: 10, fetchedAt: Date.now() }));
    let denied = false;
    try {
      chmodSync(cachePath, 0o000);
      readFileSync(cachePath, "utf8");
    } catch {
      denied = true;
    }
    if (denied) deepEqual(usageFromCache(cfg, { SWARM_HOME: home }), { state: "unknown" });
    try { chmodSync(cachePath, 0o644); } catch { /* best-effort cleanup */ }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("usageFromCache: H7 — provider.cloud absent / ollama absent / enabled false is OFF despite a valid cache", () => {
  const home = tempHome();
  try {
    // A valid, fresh cache on disk proves the gate short-circuits BEFORE
    // reading it — not that the file happens to be missing.
    writeFileSync(usageCachePath({ SWARM_HOME: home }), JSON.stringify({ weeklyPctUsed: 42, weeklyResetsAt: "R", fetchedAt: Date.now() }));

    deepEqual(usageFromCache({}, { SWARM_HOME: home }), { state: "unknown" });
    deepEqual(usageFromCache({ provider: {} }, { SWARM_HOME: home }), { state: "unknown" });
    deepEqual(usageFromCache({ provider: { cloud: {} } }, { SWARM_HOME: home }), { state: "unknown" });
    deepEqual(usageFromCache({ provider: { cloud: { ollama: { enabled: false } } } }, { SWARM_HOME: home }), { state: "unknown" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("usageFromCache: H7 — enabled with no cookie ever saved meets nothing, no fetch attempted", () => {
  const home = tempHome();
  try {
    // enabled, but no fetch has ever succeeded: no cache file exists and
    // cookiePath points nowhere. usageFromCache has no fetch capability at
    // all, so this can only resolve via the missing-cache branch.
    const cfg = { provider: { cloud: { ollama: { enabled: true, cookiePath: join(home, "missing-cookie") } } } };
    deepEqual(usageFromCache(cfg, { SWARM_HOME: home }), { state: "unknown" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- P1-P4: the parse ------------------------------------------------------

test("parseUsage: P1 — a captured settings page parses to session+weekly only", () => {
  const r = parseUsage(FIXTURE);
  equal(r.sessionPctUsed, 12);
  equal(r.sessionResetsAt, "2026-09-06T04:10:00.377393+00:00");
  equal(r.weeklyPctUsed, 83.8);
  equal(r.weeklyResetsAt, "2026-09-12T08:00:00.377418+00:00");
  deepEqual(Object.keys(r).sort(), ["sessionModels", "sessionPctUsed", "sessionResetsAt", "weeklyModels", "weeklyPctUsed", "weeklyResetsAt"].sort());
});

test("parseUsage: P2 — a missing anchor yields unknown, never a number", () => {
  const noWeeklyLabel = FIXTURE.replace('aria-label="Weekly usage 83.8% used"', 'data-weekly-usage="83.8% used"');
  deepEqual(parseUsage(noWeeklyLabel), { state: "unknown" });

  const noWeeklyTime = FIXTURE.replace(
    '<span class="local-time" data-time="2026-09-12T08:00:00.377418+00:00">Resets in 6 days.</span>',
    '<span class="local-time">Resets in 6 days.</span>'
  );
  deepEqual(parseUsage(noWeeklyTime), { state: "unknown" });
});

test("parseUsage: P3 — layout growth does not shift the answer", () => {
  const filler = `<div class="decoy">${"x".repeat(500)}</div>`;
  const grown = FIXTURE
    .replace('<main data-usage-track="true">', `<main data-usage-track="true">${filler}`)
    .replace('<section class="usage-bar" data-bar="weekly">', `${filler}<section class="usage-bar" data-bar="weekly">`)
    .replace("</main>", `${filler}</main>`)
    .replace(
      '<span data-usage-segment data-model="minimax:cloud" data-requests="8" style="width:20%"></span>',
      '<span data-usage-segment data-model="minimax:cloud" data-requests="8" style="width:20%"></span>'.repeat(20)
    );
  // The grown page's 21 segment copies sum to 500% — the sum-to-100 guard
  // rejects that bar as unmeasured, so weeklyModels differs from the fixture's
  // BY DESIGN. What must not shift under layout growth is the four bar fields.
  const { sessionModels: gs, weeklyModels: gw, ...grownBars } = parseUsage(grown);
  const { sessionModels: fs, weeklyModels: fw, ...fixtureBars } = parseUsage(FIXTURE);
  deepEqual(grownBars, fixtureBars);
  deepEqual(gw, [], "the 500%-sum bar is not measured");
  equal(fw.length, 2, "the intact fixture bar still is");
});

test("parseUsage: P4 — session and weekly are not confused for each other", () => {
  const r = parseUsage(FIXTURE);
  ok(r.sessionPctUsed !== r.weeklyPctUsed);
  ok(r.sessionResetsAt !== r.weeklyResetsAt);
  equal(r.sessionPctUsed, 12);
  equal(r.weeklyPctUsed, 83.8);
});

// ---- S1-S3: per-model segments, scoped per bar --------------------------------
// The weekly bar's segment list is what `swarm cost` derives multipliers from;
// a segment attributed to the wrong bar poisons a model's cost for a week.

test("parseUsage: S1 — the weekly bar's segments parse with model, requests and share", () => {
  const r = parseUsage(FIXTURE);
  deepEqual(r.sessionModels, [], "the session bar in this fixture carries no segments");
  deepEqual(r.weeklyModels, [
    { model: "glm-5.3:cloud", requests: 12, meterSharePct: 80 },
    { model: "minimax:cloud", requests: 8, meterSharePct: 20 },
  ]);
});

// The captured live page — the scoping assertion the plan names. The raw page
// carries a 16th data-usage-segment occurrence inside an inline script; only a
// tree-scoped parse leaves it out while keeping every real segment.
test("parseUsage: S2 — a captured live page scopes 7 session / 8 weekly segments", () => {
  const live = readFileSync(join(import.meta.dirname, "fixtures", "ollama-settings-live.html"), "utf8");
  const r = parseUsage(live);
  equal(r.sessionModels.length, 7);
  equal(r.weeklyModels.length, 8);
  for (const s of [...r.sessionModels, ...r.weeklyModels]) {
    ok(typeof s.model === "string" && s.model, `model missing on ${JSON.stringify(s)}`);
    ok(Number.isFinite(s.requests), `requests not numeric on ${JSON.stringify(s)}`);
    ok(typeof s.meterSharePct === "number", `share missing on ${JSON.stringify(s)}`);
  }
  // document-wide there are 15 elements — 7+8 means no bar claimed another's
  equal(parseHtml(live).querySelectorAll("[data-usage-segment]").length, 15);
});

test("parseUsage: S2b — wrapper-nested segments stay scoped to their own bar", () => {
  const html = readFileSync(join(import.meta.dirname, "fixtures", "two-bars.html"), "utf8");
  const r = parseUsage(html);
  deepEqual(r.sessionModels.map((s) => s.model), ["a", "b", "c"]);
  deepEqual(r.weeklyModels.map((s) => s.model), ["d", "e"]);
  equal(r.sessionModels.find((s) => s.model === "b").requests, 3);
  equal(r.sessionModels.find((s) => s.model === "b").meterSharePct, 30);
});

// Malformed segments are dropped BEFORE the sum check — the guard certifies
// exactly the segments it returns, so junk must not poison a good bar.
test("parseUsage: S3 — a segment missing model, requests or width is dropped, the rest still measure", () => {
  const good = '<span data-usage-segment data-model="glm-5.3:cloud" data-requests="12" style="width:80%"></span>';
  const grown = FIXTURE.replace(good,
    '<span data-usage-segment data-requests="12" style="width:80%"></span>'          // no data-model
    + '<span data-usage-segment data-model="junk:cloud" style="width:80%"></span>'   // no data-requests
    + '<span data-usage-segment data-model="junk:cloud" data-requests="1" style="background:#f00"></span>' // no width
    + good);
  const r = parseUsage(grown);
  deepEqual(r.weeklyModels, [
    { model: "glm-5.3:cloud", requests: 12, meterSharePct: 80 },
    { model: "minimax:cloud", requests: 8, meterSharePct: 20 },
  ], "the three junk segments are gone; the two real ones still sum to 100 and measure");
});

// ---- 8a/8b: the sum-to-100 guard and history banking -------------------------

// Test 8a — meterSharePct comes from presentational widths; if a bar's segments
// don't sum to 100 the page has changed shape and the shares are NOT measured.
// RED input: an implementation without the guard returns (and banks) the
// 62%-sum bar as if it were measured.
test("parseUsage: 8a — a bar whose widths don't sum to 100 yields [] segments; the reading still parses", () => {
  const bad = FIXTURE.replace('style="width:80%"', 'style="width:42%"'); // 42 + 20 = 62
  const r = parseUsage(bad);
  equal(r.weeklyPctUsed, 83.8, "the bar's own percentage still parses — headroom is unaffected");
  equal(r.sessionPctUsed, 12);
  deepEqual(r.weeklyModels, [], "RED: widths summing to 62 were accepted as measured shares");

  // presentation rounds to 0.1% per segment — the guard's tolerance is ±0.5
  for (const w of [79.9, 80.1]) {
    const variant = parseUsage(FIXTURE.replace('style="width:80%"', `style="width:${w}%"`));
    equal(variant.weeklyModels.length, 2, `RED: ${w}+20 sums within ±0.5 of 100 — must be accepted`);
  }
});

test("getUsage: 8a — a bad-sum bar banks no history line, and headroom still reads live", async () => {
  const home = tempHome();
  try {
    saveCookie(join(home, "ollama-cookie.json"), "tok");
    const bad = FIXTURE.replace('style="width:80%"', 'style="width:42%"');
    const okFetch = async () => ({ status: 200, headers: { get: () => null }, text: async () => bad });
    const r = await getUsage(cfgEnabled(), { env: { SWARM_HOME: home }, _fetch: okFetch, _now: () => FIFTY });
    equal(r.provenance, "live");
    equal(r.state, "ok", "headroom is unaffected by a rejected segment list");
    equal(r.weeklyPctUsed, 83.8);
    ok(!existsSync(usageHistoryPath({ SWARM_HOME: home })), "RED: a 62%-sum bar was banked as a measured week");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Test 8b — every live fetch with measurable segments banks one snapshot for
// `swarm cost`. Only LIVE readings bank: a cached fallback would re-stamp the
// same week's shape and double-count it in the request-weighted mean.
test("getUsage: 8b — a successful live fetch banks exactly one history line, shaped for `swarm cost`", async () => {
  const home = tempHome();
  try {
    saveCookie(join(home, "ollama-cookie.json"), "tok");
    const okFetch = async () => ({ status: 200, headers: { get: () => null }, text: async () => FIXTURE });
    const r = await getUsage(cfgEnabled(), { env: { SWARM_HOME: home }, _fetch: okFetch, _now: () => FIFTY });
    equal(r.provenance, "live");
    const banked = readSnapshots(usageHistoryPath({ SWARM_HOME: home }));
    equal(banked.length, 1, "one live fetch, one banked snapshot");
    deepEqual(banked[0], {
      provider: "ollama",
      runner: "claude",
      unit: "meter-points",
      source: "ollama-settings",
      classification: "unpriced",
      asOf: new Date(FIFTY).toISOString(),
      fetchedAt: FIFTY,
      weeklyPctUsed: 83.8,
      weeklyResetsAt: "2026-09-12T08:00:00.377418+00:00",
      weeklyModels: [
        { model: "glm-5.3:cloud", requests: 12, meterSharePct: 80 },
        { model: "minimax:cloud", requests: 8, meterSharePct: 20 },
      ],
    });

    // Past the TTL, so the read really is attempted and really does fail.
    const redirectFetch = async () => ({ status: 303, headers: { get: () => "https://ollama.com/signin" }, text: async () => "" });
    const cached = await getUsage(cfgEnabled(), { env: { SWARM_HOME: home }, _fetch: redirectFetch, _now: () => FIFTY + SIX_MIN });
    equal(cached.provenance, "stale");
    equal(readSnapshots(usageHistoryPath({ SWARM_HOME: home })).length, 1, "a stale fallback never banks");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- P5-P7: fetch, cookie, config ------------------------------------------

// The fetch writes nothing: it RETURNS the reading for usage-cache to bank, so
// a failure leaves the existing snapshot at its own age instead of re-stamping it.
test("fetchUsage: happy path parses a live-shaped response and writes no file", async () => {
  const home = tempHome();
  try {
    const okFetch = async () => ({ status: 200, headers: { get: () => null }, text: async () => FIXTURE });
    const r = await fetchUsage({ cookie: "session=abc", _fetch: okFetch, _now: () => 555 });
    equal(r.ok, true);
    equal(r.weeklyPctUsed, 83.8);
    equal(r.fetchedAt, 555);
    deepEqual(readdirSync(home), [], "the reading is banked by the caller, never here");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("fetchUsage: P5 — an expired cookie is reported explicitly and nothing is written", async () => {
  const home = tempHome();
  try {
    const redirectFetch = async () => ({
      status: 303,
      headers: { get: (h) => (h === "location" ? "https://ollama.com/signin" : null) },
      text: async () => "",
    });
    deepEqual(await fetchUsage({ cookie: "stale", _fetch: redirectFetch }), { ok: false, reason: "expired-cookie" });

    const noMarkerFetch = async () => ({ status: 200, headers: { get: () => null }, text: async () => "<html>signed out</html>" });
    deepEqual(await fetchUsage({ cookie: "stale", _fetch: noMarkerFetch }), { ok: false, reason: "expired-cookie" });
    deepEqual(readdirSync(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("saveCookie/loadCookie: P6 — the cookie is persisted to its own file, never into config.json", () => {
  const home = tempHome();
  try {
    const cookiePath = join(home, "ollama-cookie");
    saveCookie(cookiePath, "  abc123==  ");
    equal(loadCookie(cookiePath), "abc123==");
    // A later call without --cookie reads the same saved value.
    equal(loadCookie(cookiePath), "abc123==");

    const configPath = join(home, "config.json");
    writeFileSync(configPath, JSON.stringify({ provider: { cloud: { ollama: { enabled: true, cookiePath } } } }));
    ok(!readFileSync(configPath, "utf8").includes("abc123"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("initConfig: P7 — materialises provider.cloud.ollama DISABLED, real leaves", () => {
  const home = tempHome();
  try {
    const configPath = join(home, "config.json");
    const { added } = initConfig(configPath, { SWARM_HOME: home });
    ok(added.includes("providers.ollama.cloud.ollama.enabled"));
    ok(added.includes("providers.ollama.cloud.ollama.cookiePath"));
    ok(added.includes("providers.ollama.usageTimeoutMs"));

    const written = JSON.parse(readFileSync(configPath, "utf8"));
    equal(written.providers.ollama.cloud.ollama.enabled, false);
    equal(written.providers.ollama.cloud.ollama.cookiePath, null);
    equal(written.providers.ollama.usageTimeoutMs, 5000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("SETTINGS_URL is the ollama settings page", () => {
  equal(SETTINGS_URL, "https://ollama.com/settings");
});

// H8 — session rides along on every reading. RED before this: readUsage parsed
// session into the cache and then dropped it, so no caller could ever see the
// bar that blocks dispatch RIGHT NOW.
test("readUsage: H8 carries session alongside weekly, in every state", () => {
  const now = 2_000_000_000_000;
  const base = {
    sessionPctUsed: 100, sessionResetsAt: "2026-09-06T12:00:00Z",
    weeklyPctUsed: 40, weeklyResetsAt: "2026-09-12T08:00:00Z",
  };
  const ok = readUsage(JSON.stringify({ ...base, fetchedAt: now - 1000 }), { now });
  equal(ok.state, "ok", "a full session bar does not change the weekly verdict");
  equal(ok.sessionPctUsed, 100);
  equal(ok.sessionResetsAt, "2026-09-06T12:00:00Z");

  const full = readUsage(JSON.stringify({ ...base, weeklyPctUsed: 100, fetchedAt: now - 1000 }), { now });
  equal(full.state, "exhausted");
  equal(full.sessionPctUsed, 100, "session survives the exhausted branch too");
});
