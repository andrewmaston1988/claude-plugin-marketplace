import { test } from "node:test";
import assert from "node:assert/strict";
import { detectForeground, returnTo } from "../src/tv/return-app.mjs";
import { appIds } from "../src/tv/sdb.mjs";

const HOST = "192.0.2.10:26101";
const BASE = "http://192.0.2.10:8001";
const WIDGET = "torrenthub.shell";
const APPLE_TV = "3201807016597";
const YOUTUBE = "9Ur5IzDKqV.TizenYouTube";
const ITVX = "OEvCiupaFR.ITVHub";
const CONFIG = { tv: { host: HOST, appid: WIDGET } };

// The shape `sdb shell 0 applist` prints: a header, a rule, then quoted columns. The name
// holds a fullwidth ampersand, which is what a naive split on `&` would mangle.
const APPLIST = [
  "PkgId                                    Ver       Name",
  "------------------------------------------------------------------------",
  `'ITVX'\t                                 '1.0.0'\t  '${ITVX}'`,
  "'Tom ＆ Jerry'\t                         '2.1'\t    'abc123.tom'",
  `'Torrent Test'\t                         '1.0'\t    '${WIDGET}'`,
].join("\n");

// The set that hides Apple TV behind a dummy id: applist names the dummy, REST 404s it.
// The 404 leads a first batch of four; the app that is showing waits in the second batch.
const HIDDEN_APPLE_TV = [
  "PkgId                                    Ver       Name",
  "------------------------------------------------------------------------",
  `'Apple TV'\t                             '1.0'\t    'com.samsung.tv.aria-dummy'`,
  `'Netflix'\t                              '1.0'\t    'abc.netflix'`,
  `'Tubi'\t                                  '1.0'\t    '3KA0pm7a7V.TubiTV'`,
  `'Prime Video'\t                          '1.0'\t    'abc.primevideo'`,
  `'YouTube'\t                              '1.0'\t    '${YOUTUBE}'`,
  `'Torrent Test'\t                         '1.0'\t    '${WIDGET}'`,
].join("\n");

/** One response in the shape the plugin's own `fetch` returns. */
const answer = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
const showing = (id, name) => answer({ id, name, running: true, visible: true });
const hidden = (id, name) => answer({ id, name, running: true, visible: false });

/** Routes a request by the id at the end of its path; records every call. */
function fetchStub(routes) {
  const calls = [];
  const stub = async (url, options = {}) => {
    const id = new URL(url).pathname.split("/").pop();
    const entry = { url, id, method: options.method ?? "GET", timeoutMs: null, signal: options.signal };
    calls.push(entry);
    const route = routes[id];
    if (route === undefined) throw new Error(`no fixture for ${id}`);
    return route(entry);
  };
  stub.calls = calls;
  stub.ids = () => calls.map((call) => call.id);
  stub.posts = () => calls.filter((call) => call.method === "POST");
  return stub;
}

/** A session scripted by phase: the re-read, the POST, then each poll in order. */
function fetchScript({ reread, post = answer({ running: true, visible: true }), polls = [] }) {
  let launched = false;
  let poll = 0;
  const calls = [];
  const stub = async (url, options = {}) => {
    const entry = { url, id: new URL(url).pathname.split("/").pop(), method: options.method ?? "GET", signal: options.signal };
    calls.push(entry);
    if (entry.method === "POST") {
      launched = true;
      return typeof post === "function" ? post(entry) : post;
    }
    const step = launched ? polls[poll++] : reread;
    if (step === undefined) throw new Error("the script ran out of poll answers");
    return typeof step === "function" ? step(entry) : step;
  };
  stub.calls = calls;
  stub.posts = () => calls.filter((call) => call.method === "POST");
  stub.polls = () => poll;
  return stub;
}

// ── Row 4: detection order ────────────────────────────────────────────────────────────

test("a configured app that is visible is found with one GET and no applist", async () => {
  const sdbCalls = [];
  const stub = fetchStub({ [APPLE_TV]: () => showing(APPLE_TV, "Apple TV") });

  const found = await detectForeground({
    config: { tv: { ...CONFIG.tv, returnApps: [APPLE_TV] } },
    callSdb: async (argv) => { sdbCalls.push(argv); return { code: 0, stdout: APPLIST }; },
    _fetch: stub,
  });

  assert.deepEqual(found, { id: APPLE_TV, name: "Apple TV" });
  assert.deepEqual(stub.ids(), [APPLE_TV], "the configured id costs one GET");
  assert.deepEqual(sdbCalls, [], "applist is not consulted when a configured app is showing");
});

test("when no configured app is showing, the applist scan finds the one that is", async () => {
  const stub = fetchStub({
    [APPLE_TV]: () => hidden(APPLE_TV, "Apple TV"),
    [ITVX]: () => showing(ITVX, "ITVX"),
    "abc123.tom": () => hidden("abc123.tom", "Tom & Jerry"),
    [WIDGET]: () => showing(WIDGET, "Torrent Test"),
  });
  const sdbCalls = [];

  const found = await detectForeground({
    config: { tv: { ...CONFIG.tv, returnApps: [APPLE_TV] } },
    callSdb: async (argv) => { sdbCalls.push(argv); return { code: 0, stdout: APPLIST }; },
    _fetch: stub,
  });

  assert.deepEqual(found, { id: ITVX, name: "ITVX" });
  assert.deepEqual(sdbCalls, [["shell", "0", "applist"]]);
  assert.equal(stub.ids().includes(WIDGET), false, "the widget is the tool's own app, never a candidate");
  assert.deepEqual(stub.ids(), [APPLE_TV, ITVX, "abc123.tom"], "the scan stops at the first visible one");
});

// ── Row 5: the applist format and the scan ────────────────────────────────────────────

test("appIds reads the app id from each applist row, whatever its name holds", () => {
  assert.deepEqual(appIds(APPLIST), [ITVX, "abc123.tom", WIDGET]);
  assert.deepEqual(appIds(""), []);
  assert.deepEqual(appIds(undefined), []);
});

test("the applist scan keeps at most 4 reads in flight", async () => {
  const list = Array.from({ length: 10 }, (_, index) => `app${index}.main`).join("\n");
  const sdb = `PkgId Ver Name\n${list.split("\n").map((id) => `'name'\t '${id}'`).join("\n")}`;
  let inFlight = 0;
  let peak = 0;

  const stub = async (url) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return hidden(new URL(url).pathname.split("/").pop(), "nobody");
  };

  const found = await detectForeground({ config: CONFIG, callSdb: async () => ({ stdout: sdb }), _fetch: stub });

  assert.equal(found, null);
  assert.ok(peak <= 4, `no more than 4 detection GETs at once, saw ${peak}`);
});

test("a candidate answering 404 is skipped, and a later visible app is still found", async () => {
  const stub = fetchStub({
    "com.samsung.tv.aria-dummy": () => answer({ code: 404, message: "Not Found" }, 404),
    "abc.netflix": () => hidden("abc.netflix", "Netflix"),
    "3KA0pm7a7V.TubiTV": () => hidden("3KA0pm7a7V.TubiTV", "Tubi"),
    "abc.primevideo": () => hidden("abc.primevideo", "Prime Video"),
    [YOUTUBE]: () => showing(YOUTUBE, "YouTube"),
    [WIDGET]: () => showing(WIDGET, "Torrent Test"),
  });

  const found = await detectForeground({
    config: CONFIG,
    callSdb: async () => ({ stdout: HIDDEN_APPLE_TV }),
    _fetch: stub,
  });

  assert.deepEqual(found, { id: YOUTUBE, name: "YouTube" });
  assert.deepEqual(
    stub.ids(),
    ["com.samsung.tv.aria-dummy", "abc.netflix", "3KA0pm7a7V.TubiTV", "abc.primevideo", YOUTUBE],
    "the 404 is skipped and the search goes on into the next batch; the widget is never asked",
  );
});

// ── Row 6: detection never fails the run ──────────────────────────────────────────────

test("nothing visible is null, not a failure", async () => {
  const stub = fetchStub({
    [ITVX]: () => hidden(ITVX, "ITVX"),
    "abc123.tom": () => hidden("abc123.tom", "Tom & Jerry"),
  });

  const found = await detectForeground({ config: CONFIG, callSdb: async () => ({ stdout: APPLIST }), _fetch: stub });
  assert.equal(found, null);
});

test("a transport failure ends detection as not read, without throwing", async () => {
  const found = await detectForeground({
    config: CONFIG,
    callSdb: async () => ({ stdout: APPLIST }),
    _fetch: async () => {
      throw new Error("connect ECONNREFUSED 192.0.2.10:8001");
    },
  });

  assert.match(found.error, /ECONNREFUSED/);
  assert.equal(found.id, undefined);
});

test("detection gives up at its 8 s budget", async () => {
  let clock = 0;
  const found = await detectForeground({
    config: { tv: { ...CONFIG.tv, returnApps: [APPLE_TV, "111299001912"] } },
    callSdb: async () => ({ stdout: APPLIST }),
    _fetch: async () => {
      clock += 4000;
      return hidden(APPLE_TV, "Apple TV");
    },
    _now: () => clock,
  });

  assert.match(String(found?.error), /ran out of time/, "the budget ends the search rather than walking every id");
});

test("an applist sdb will not answer is not read, not fatal", async () => {
  const found = await detectForeground({
    config: CONFIG,
    callSdb: async () => {
      throw new Error("sdb died");
    },
    _fetch: async () => hidden(ITVX, "ITVX"),
  });

  assert.match(found.error, /could not list the TV's apps: sdb died/);
});

test("a tv block without a host is not read, not fatal", async () => {
  const found = await detectForeground({ config: { tv: { appid: WIDGET } }, callSdb: async () => ({ stdout: "" }) });
  assert.match(found.error, /tv\.host/);
});

// ── Row 7: the restore ────────────────────────────────────────────────────────────────

const APPLE = { id: APPLE_TV, name: "Apple TV" };
const instant = async () => {};

test("an app already visible on the re-read is left alone", async () => {
  const stub = fetchScript({ reread: showing(APPLE_TV, "Apple TV") });

  const record = await returnTo(APPLE, { config: CONFIG, _fetch: stub, _sleep: instant, _now: () => 0 });

  assert.deepEqual(record, { id: APPLE_TV, name: "Apple TV", outcome: "already showing" });
  assert.deepEqual(stub.posts(), [], "nothing was displaced, so nothing is posted");
});

test("a relaunch that comes up visible is returned", async () => {
  const stub = fetchScript({
    reread: hidden(APPLE_TV, "Apple TV"),
    polls: [hidden(APPLE_TV, "Apple TV"), showing(APPLE_TV, "Apple TV")],
  });

  const record = await returnTo(APPLE, { config: CONFIG, _fetch: stub, _sleep: instant, _now: () => 0 });

  assert.deepEqual(record, { id: APPLE_TV, name: "Apple TV", outcome: "returned" });
  assert.equal(stub.posts().length, 1);
  assert.equal(stub.polls(), 2);
});

test("a relaunch that never shows within 5 s is reported, not retried forever", async () => {
  let clock = 0;
  const neverVisible = Array.from({ length: 10 }, () => () => hidden(APPLE_TV, "Apple TV"));
  const stub = fetchScript({ reread: hidden(APPLE_TV, "Apple TV"), polls: neverVisible });

  const record = await returnTo(APPLE, {
    config: CONFIG,
    _fetch: stub,
    _sleep: async (ms) => { clock += ms; },
    _now: () => clock,
  });

  assert.equal(record.outcome, "launched, not visible after 5 s");
  assert.equal(stub.polls(), 10, "one poll every 500 ms across the 5 s window");
  assert.equal(clock, 5000);
});

test("a poll that throws is reported as not confirmed", async () => {
  const stub = fetchScript({
    reread: hidden(APPLE_TV, "Apple TV"),
    polls: [() => { throw new Error("socket hang up"); }],
  });

  const record = await returnTo(APPLE, { config: CONFIG, _fetch: stub, _sleep: instant, _now: () => 0 });
  assert.deepEqual(record, { id: APPLE_TV, name: "Apple TV", outcome: "launched, not confirmed: socket hang up" });
});

test("a POST the TV refuses is reported as failed", async () => {
  const stub = fetchScript({ reread: hidden(APPLE_TV, "Apple TV"), post: () => answer("", 500) });

  const record = await returnTo(APPLE, { config: CONFIG, _fetch: stub, _sleep: instant, _now: () => 0 });
  assert.match(record.outcome, /^failed: POST \/api\/v2\/applications\/3201807016597 → HTTP 500$/);
});

test("an unreadable re-read still tries the launch", async () => {
  const stub = fetchScript({
    reread: () => { throw new Error("socket hang up"); },
    polls: [showing(APPLE_TV, "Apple TV")],
  });

  const record = await returnTo(APPLE, { config: CONFIG, _fetch: stub, _sleep: instant, _now: () => 0 });
  assert.equal(record.outcome, "returned");
  assert.equal(stub.posts().length, 1);
});

test("a poll's read is capped at what is left of the 5 s window", async () => {
  let clock = 0;
  let launched = false;
  let polls = 0;

  const stub = async (url, options = {}) => {
    if (options.method === "POST") {
      launched = true;
      return answer({ running: true, visible: true });
    }
    if (!launched) return hidden(APPLE_TV, "Apple TV");
    polls += 1;
    if (polls === 1) {
      clock = 4900; // the launch ate the window; 100 ms is all that is left
      return hidden(APPLE_TV, "Apple TV");
    }
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
    });
  };

  const record = await returnTo(APPLE, { config: CONFIG, _fetch: stub, _sleep: instant, _now: () => clock });

  assert.match(record.outcome, /launched, not confirmed: GET .* did not answer within 100 ms$/);
});

test("the record follows the id that was detected, not the one the TV echoes back", async () => {
  const stub = fetchScript({
    reread: hidden("111299001912", "YouTube"),
    polls: [answer({ id: "some-other-id", name: "YouTube", running: true, visible: true })],
  });

  const record = await returnTo({ id: "111299001912", name: "YouTube" }, {
    config: CONFIG, _fetch: stub, _sleep: instant, _now: () => 0,
  });
  assert.deepEqual(record, { id: "111299001912", name: "YouTube", outcome: "returned" });
  assert.equal(new URL(stub.posts()[0].url).pathname, "/api/v2/applications/111299001912");
});

test("a hostless config is reported as failed, not thrown", async () => {
  const record = await returnTo(APPLE, {
    config: { tv: { appid: WIDGET } },
    _fetch: async () => { throw new Error("the TV is off"); },
    _sleep: instant,
    _now: () => 0,
  });
  assert.match(record.outcome, /^failed: tv\.host/);
  assert.equal(record.id, APPLE_TV);
});
