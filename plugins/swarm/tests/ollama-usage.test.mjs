import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SETTINGS_URL, fetchUsage, parseUsage, readUsage, usageFromCache, usageCachePath,
  saveCookie, loadCookie,
} from "../src/ollama-usage.mjs";
import { initConfig } from "../src/config.mjs";

const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures", "ollama-settings.html"), "utf8");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "swarm-ollama-usage-"));
}

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

test("readUsage: H3 stale beats exhausted — a week-old 100% is stale, not exhausted", () => {
  const staleMs = 86_400_000;
  const now = 2_000_000_000_000;
  const cache = JSON.stringify({ weeklyPctUsed: 100, weeklyResetsAt: "R", fetchedAt: now - (staleMs + 1) });
  equal(readUsage(cache, { now, staleMs }).state, "stale");
});

test("readUsage: H4 unknown — empty, whitespace, unparseable, or missing weeklyPctUsed, never throws", () => {
  for (const text of ["", "   ", "{not json", JSON.stringify({ foo: "bar" })]) {
    deepEqual(readUsage(text, { now: 0 }), { state: "unknown" });
  }
});

test("readUsage: H5 boundaries — 99.9 ok / 100 exhausted; age staleMs stale / staleMs-1 not stale", () => {
  const staleMs = 86_400_000;
  const now = 2_000_000_000_000;
  const fresh = { weeklyResetsAt: "R", fetchedAt: now - 1000 };
  equal(readUsage(JSON.stringify({ ...fresh, weeklyPctUsed: 99.9 }), { now, staleMs }).state, "ok");
  equal(readUsage(JSON.stringify({ ...fresh, weeklyPctUsed: 100 }), { now, staleMs }).state, "exhausted");

  const atBoundary = JSON.stringify({ weeklyPctUsed: 50, weeklyResetsAt: "R", fetchedAt: now - staleMs });
  equal(readUsage(atBoundary, { now, staleMs }).state, "stale");
  const justUnder = JSON.stringify({ weeklyPctUsed: 50, weeklyResetsAt: "R", fetchedAt: now - (staleMs - 1) });
  equal(readUsage(justUnder, { now, staleMs }).state, "ok");
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
  deepEqual(Object.keys(r).sort(), ["sessionPctUsed", "sessionResetsAt", "weeklyPctUsed", "weeklyResetsAt"].sort());
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
  deepEqual(parseUsage(grown), parseUsage(FIXTURE));
});

test("parseUsage: P4 — session and weekly are not confused for each other", () => {
  const r = parseUsage(FIXTURE);
  ok(r.sessionPctUsed !== r.weeklyPctUsed);
  ok(r.sessionResetsAt !== r.weeklyResetsAt);
  equal(r.sessionPctUsed, 12);
  equal(r.weeklyPctUsed, 83.8);
});

// ---- P5-P7: fetch, cookie, config ------------------------------------------

test("fetchUsage: happy path parses a live-shaped response and writes the cache", async () => {
  const home = tempHome();
  try {
    const cachePath = join(home, "ollama-usage.json");
    const okFetch = async () => ({ status: 200, headers: { get: () => null }, text: async () => FIXTURE });
    const r = await fetchUsage({ cookie: "session=abc", cachePath, _fetch: okFetch, _now: () => 555 });
    equal(r.ok, true);
    equal(r.weeklyPctUsed, 83.8);
    equal(r.fetchedAt, 555);
    deepEqual(JSON.parse(readFileSync(cachePath, "utf8")), {
      sessionPctUsed: 12,
      sessionResetsAt: "2026-09-06T04:10:00.377393+00:00",
      weeklyPctUsed: 83.8,
      weeklyResetsAt: "2026-09-12T08:00:00.377418+00:00",
      fetchedAt: 555,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("fetchUsage: P5 — an expired cookie is reported explicitly and the cache is never touched", async () => {
  const home = tempHome();
  try {
    const cachePath = join(home, "ollama-usage.json");
    writeFileSync(cachePath, JSON.stringify({ weeklyPctUsed: 10, fetchedAt: 111 }));
    const before = readFileSync(cachePath, "utf8");

    const redirectFetch = async () => ({
      status: 303,
      headers: { get: (h) => (h === "location" ? "https://ollama.com/signin" : null) },
      text: async () => "",
    });
    deepEqual(await fetchUsage({ cookie: "stale", cachePath, _fetch: redirectFetch }), { ok: false, reason: "expired-cookie" });
    equal(readFileSync(cachePath, "utf8"), before);

    const noMarkerFetch = async () => ({ status: 200, headers: { get: () => null }, text: async () => "<html>signed out</html>" });
    deepEqual(await fetchUsage({ cookie: "stale", cachePath, _fetch: noMarkerFetch }), { ok: false, reason: "expired-cookie" });
    equal(readFileSync(cachePath, "utf8"), before);
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
    ok(added.includes("provider.cloud.ollama.enabled"));
    ok(added.includes("provider.cloud.ollama.cookiePath"));
    ok(added.includes("provider.usageStaleMs"));

    const written = JSON.parse(readFileSync(configPath, "utf8"));
    equal(written.provider.cloud.ollama.enabled, false);
    equal(written.provider.cloud.ollama.cookiePath, null);
    equal(written.provider.usageStaleMs, 86400000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("SETTINGS_URL is the ollama settings page", () => {
  equal(SETTINGS_URL, "https://ollama.com/settings");
});
