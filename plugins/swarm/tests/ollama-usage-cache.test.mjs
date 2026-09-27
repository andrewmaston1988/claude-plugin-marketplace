// The cache half of the ollama reading: what `getUsage` does under the 5-minute
// TTL, what a failed refresh leaves behind, and what the cache-only reader sees.
// Split from ollama-usage.test.mjs, which is over the 500-line bar.
import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SETTINGS_URL, fetchUsage, getUsage, saveCookie, usageCachePath, usageFromCache, recordUsageError } from "../src/ollama-usage.mjs";

const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures", "ollama-settings.html"), "utf8");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "swarm-ollama-usage-"));
}

// ---- H9-H18: getUsage — provenance, TTL, timeout, error recording ----------

const cfgEnabled = (extra = {}) => ({ provider: { cloud: { ollama: { enabled: true, ...extra } } } });
const FIFTY = 2_000_000_000_000;
const SIX_MIN = 6 * 60_000; // one minute past the 5-minute TTL

// The reading the cache holds, wrapped in the envelope usage-cache owns: the
// classified result, and when it was fetched.
function cacheFixture(home, reading, { fetchedAt, ...extra } = {}) {
  const p = usageCachePath({ SWARM_HOME: home });
  writeFileSync(p, JSON.stringify({ fetchedAt, result: reading, ...extra }));
  return p;
}

test("getUsage: H9 a successful fetch is provenance live, classified through the same readUsage", async () => {
  const home = tempHome();
  try {
    saveCookie(join(home, "ollama-cookie.json"), "tok");
    const okFetch = async () => ({ status: 200, headers: { get: () => null }, text: async () => FIXTURE });
    const r = await getUsage(cfgEnabled(), { env: { SWARM_HOME: home }, _fetch: okFetch, _now: () => FIFTY });
    equal(r.provenance, "live");
    equal(r.state, "ok");
    equal(r.weeklyPctUsed, 83.8);
    // the cache was written and carries the reading back out
    deepEqual(JSON.parse(readFileSync(usageCachePath({ SWARM_HOME: home }), "utf8")).fetchedAt, FIFTY);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("getUsage: H10 an expired cache whose refresh fails is provenance stale, naming reason, lastSeen, cookiePath", async () => {
  const home = tempHome();
  try {
    const age = FIFTY - 33 * 3_600_000;
    cacheFixture(home, {
      state: "ok", sessionPctUsed: 3, sessionResetsAt: "S",
      weeklyPctUsed: 8.1, resetsAt: "2026-09-12T08:00:00Z",
    }, { fetchedAt: age });
    saveCookie(join(home, "ollama-cookie.json"), "expired");
    const redirectFetch = async () => ({ status: 303, headers: { get: () => "https://ollama.com/signin" }, text: async () => "" });
    const r = await getUsage(cfgEnabled(), { env: { SWARM_HOME: home }, _fetch: redirectFetch, _now: () => FIFTY });
    equal(r.provenance, "stale");
    equal(r.reason, "expired-cookie");
    equal(r.lastSeen, age, "lastSeen is the cache's own fetchedAt");
    equal(r.cookiePath, join(home, "ollama-cookie.json"));
    equal(r.weeklyPctUsed, 8.1, "the figure survives as last-known context");
    equal(r.state, "ok");
    // the failure note rides beside the reading, without re-stamping it
    const cached = JSON.parse(readFileSync(usageCachePath({ SWARM_HOME: home }), "utf8"));
    equal(cached.lastError, "expired-cookie");
    equal(cached.fetchedAt, age, "fetchedAt is never re-stamped by a failure");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("getUsage: H11 no cache either is provenance none, with the reason and the fix's cookiePath", async () => {
  const home = tempHome();
  try {
    saveCookie(join(home, "ollama-cookie.json"), "tok");
    const r = await getUsage(cfgEnabled(), { env: { SWARM_HOME: home }, _fetch: async () => { throw new Error("down"); }, _now: () => FIFTY });
    equal(r.state, "unknown");
    equal(r.provenance, "none");
    equal(r.reason, "network-error");
    equal(r.cookiePath, join(home, "ollama-cookie.json"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("getUsage: H12 the enabled gate — off means bare unknown and NO fetch, gate:false overrides", async () => {
  const home = tempHome();
  saveCookie(join(home, "ollama-cookie.json"), "tok");
  let fetches = 0;
  const counting = async () => { fetches++; return { status: 200, headers: { get: () => null }, text: async () => FIXTURE }; };
  const off = { provider: { cloud: { ollama: { enabled: false } } } };
  deepEqual(await getUsage(off, { env: { SWARM_HOME: home }, _fetch: null }), { state: "unknown" });
  deepEqual(await getUsage({}, { env: { SWARM_HOME: home }, _fetch: null }), { state: "unknown" });
  equal(fetches, 0, "a disabled provider never reaches for the network");

  const r = await getUsage(off, { env: { SWARM_HOME: home }, _fetch: counting, _now: () => FIFTY, gate: false });
  equal(r.provenance, "live", "the ollama-usage subcommand fetches even before ollama is enabled");
  equal(fetches, 1);

  await getUsage(cfgEnabled(), { env: { SWARM_HOME: home }, _fetch: counting, _now: () => FIFTY + 1000 });
  equal(fetches, 1, "the reading just banked answers the next call inside its TTL");
});

test("getUsage: H13 no-cookie over an expired cache is provenance stale with its own reason", async () => {
  const home = tempHome();
  try {
    // deliberately NO cookie file — that is the condition under test. The
    // reading is past its TTL, or nothing would ask the provider at all.
    cacheFixture(home, { state: "ok", weeklyPctUsed: 40, resetsAt: "R" }, { fetchedAt: FIFTY - SIX_MIN });
    const r = await getUsage(cfgEnabled(), { env: { SWARM_HOME: home }, _fetch: async () => { throw new Error("no request should fire"); }, _now: () => FIFTY });
    equal(r.provenance, "stale");
    equal(r.reason, "no-cookie");
    equal(r.weeklyPctUsed, 40);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("getUsage: H14 timeout — a fetch that never settles is bounded and reports its own reason", async () => {
  const home = tempHome();
  try {
    saveCookie(join(home, "ollama-cookie.json"), "tok");
    const neverFetch = () => new Promise(() => {});
    const started = Date.now();
    const r = await getUsage(
      { provider: { cloud: { ollama: { enabled: true } }, usageTimeoutMs: 50 } },
      { env: { SWARM_HOME: home }, _fetch: neverFetch, _now: () => Date.now() }
    );
    ok(Date.now() - started < 5000, "the timeout fired well under the suite's own ceiling");
    equal(r.provenance, "none");
    equal(r.reason, "timeout");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The memo is gone: the file's own TTL is what spares the network, so a second
// read inside the window costs nothing and a read past it really does ask the
// provider again — in the same process, which the memo could never do.
test("getUsage: H15 one fetch per 5 minutes — the second read is served from the file, the third is not", async () => {
  const home = tempHome();
  try {
    saveCookie(join(home, "ollama-cookie.json"), "tok");
    let fetches = 0;
    const countingFetch = async () => { fetches++; return { status: 200, headers: { get: () => null }, text: async () => FIXTURE }; };
    const a = await getUsage(cfgEnabled(), { env: { SWARM_HOME: home }, _fetch: countingFetch, _now: () => FIFTY });
    const b = await getUsage(cfgEnabled(), { env: { SWARM_HOME: home }, _fetch: countingFetch, _now: () => FIFTY + 60_000 });
    equal(fetches, 1, "two reads inside the TTL, one fetch");
    equal(a.weeklyPctUsed, b.weeklyPctUsed);
    equal(b.provenance, "cached", "the file answered the second read");

    const c = await getUsage(cfgEnabled(), { env: { SWARM_HOME: home }, _fetch: countingFetch, _now: () => FIFTY + SIX_MIN });
    equal(fetches, 2, "past the TTL the same process reads the provider again — no memo holds it back");
    equal(c.provenance, "live");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// `swarm usage --provider ollama` is the documented refresh, so the reading's
// age must not stop it: the reader asked for the provider's own answer, not a
// banked one.
test("getUsage: H15b force reads live through a reading inside its TTL", async () => {
  const home = tempHome();
  try {
    saveCookie(join(home, "ollama-cookie.json"), "tok");
    let fetches = 0;
    const countingFetch = async () => { fetches++; return { status: 200, headers: { get: () => null }, text: async () => FIXTURE }; };
    await getUsage(cfgEnabled(), { env: { SWARM_HOME: home }, _fetch: countingFetch, _now: () => FIFTY });
    const forced = await getUsage(cfgEnabled(), { env: { SWARM_HOME: home }, _fetch: countingFetch, _now: () => FIFTY + 1000, force: true });
    equal(fetches, 2);
    equal(forced.provenance, "live");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("fetchUsage: H16 honors an overridden url (settingsUrl seam) and passes an AbortSignal", async () => {
  let seen = null;
  const okFetch = async (url, opts) => { seen = { url, signal: opts.signal }; return { status: 200, headers: { get: () => null }, text: async () => FIXTURE }; };
  const r = await fetchUsage({ cookie: "c", url: "http://127.0.0.1:9/settings", _fetch: okFetch, _now: () => 1 });
  equal(r.ok, true);
  equal(seen.url, "http://127.0.0.1:9/settings");
  ok(seen.signal instanceof AbortSignal, "the timeout signal is passed to the fetch");
});

test("recordUsageError: H17 merges beside the reading; absent or corrupt cache is left alone", () => {
  const home = tempHome();
  try {
    const p = usageCachePath({ SWARM_HOME: home });
    recordUsageError(p, "expired-cookie", 5);
    ok(!existsSync(p), "no cache, no note — the error only matters beside a reading");

    writeFileSync(p, JSON.stringify({ fetchedAt: 111, result: { state: "ok", weeklyPctUsed: 40 } }));
    recordUsageError(p, "expired-cookie", 222);
    const merged = JSON.parse(readFileSync(p, "utf8"));
    deepEqual(merged.result, { state: "ok", weeklyPctUsed: 40 }, "the reading is untouched");
    equal(merged.fetchedAt, 111, "fetchedAt untouched");
    equal(merged.lastError, "expired-cookie");
    equal(merged.lastErrorAt, 222);

    writeFileSync(p, "{not json");
    recordUsageError(p, "network-error", 333);
    equal(readFileSync(p, "utf8"), "{not json", "a corrupt cache is never overwritten");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The cache-only reader carries the same vocabulary as getUsage, so the hook
// and `quota` mark an aged reading exactly as the fetching commands do.
test("usageFromCache: H18 a fresh reading is `cached`, an aged one `stale`, both with their own lastSeen", () => {
  const home = tempHome();
  try {
    const reading = { state: "ok", weeklyPctUsed: 40, resetsAt: "R" };
    const cfg = { provider: { cloud: { ollama: { enabled: true } } } };
    // usageFromCache has no clock seam — it reads the real one, so its fixtures
    // are laid down relative to it.
    cacheFixture(home, reading, { fetchedAt: Date.now() - 60_000 });
    equal(usageFromCache(cfg, { SWARM_HOME: home }).provenance, "cached");

    const aged = Date.now() - SIX_MIN;
    cacheFixture(home, reading, { fetchedAt: aged, lastError: "expired-cookie", lastErrorAt: 7 });
    const stale = usageFromCache(cfg, { SWARM_HOME: home });
    equal(stale.provenance, "stale");
    equal(stale.reason, "expired-cookie", "the banked failure is the reason the hook cannot fetch for");
    equal(stale.lastSeen, aged);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
