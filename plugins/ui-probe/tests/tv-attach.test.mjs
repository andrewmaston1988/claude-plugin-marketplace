import { test } from "node:test";
import assert from "node:assert/strict";
import { attach, AttachInconclusive } from "../src/tv/attach.mjs";

const HOST = "192.0.2.10:26101";
const APPID = "torrenthub.main";
const PKGID = "torrenthub";
const PORT = 43411;
const CONFIG = { tv: { host: HOST, appid: APPID } };

const DEVICES = `List of devices attached\n${HOST} \tdevice \tUE50TU7020KXXU\n`;
const NO_DEVICES = "List of devices attached\n";

function ok(stdout = "") {
  return { code: 0, stdout, stderr: "" };
}

function stubSdb(answers = {}) {
  const calls = [];
  const call = async (argv, options = {}) => {
    calls.push({ argv, ...options });
    const answer = answers[argv.join(" ")];
    const value = typeof answer === "function" ? await answer() : answer;
    return value ?? ok();
  };
  call.calls = calls;
  call.text = (from = 0) => calls.slice(from).map((entry) => entry.argv.join(" "));
  return call;
}

function stubFetch(routes) {
  const urls = [];
  const fetchStub = async (url) => {
    urls.push(url);
    const body = routes[new URL(url).pathname];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  fetchStub.urls = urls;
  return fetchStub;
}

function stubConnect() {
  const state = { closed: 0, url: null };
  const connectStub = async (url) => {
    state.url = url;
    return { close() { state.closed += 1; } };
  };
  connectStub.state = state;
  return connectStub;
}

const LIST = { "/json/list": [{ type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/1` }] };
const PROTOCOL = { "/json/protocol": { domains: [{ domain: "Network" }] } };

function launchAnswers(overrides = {}) {
  return {
    devices: ok(DEVICES),
    [`shell 0 kill ${PKGID}`]: ok(`Pkgid: ${PKGID} is Terminated`),
    [`shell 0 debug ${APPID}`]: ok(`successfully launched pid = 921 with debug 1 port: ${PORT}`),
    [`forward tcp:${PORT} tcp:${PORT}`]: ok(`${PORT}`),
    "forward --remove tcp:43411": ok(),
    ...overrides,
  };
}

const instant = async () => {};

const SETTLED = { href: "http://192.0.2.30:8000/tv?tizen=1", origin: "http://192.0.2.30:8000", ready: "complete", hasBody: true };
// Every attach waits for the settled page. Tests that are about another part of the sequence
// hand it a page that is already settled, so the wait costs them nothing.
const settledOptions = { _evaluate: async () => SETTLED, settleHoldMs: 0 };

test("attach connects, closes, launches, forwards, then reads the page target and protocol", async () => {
  const sdbStub = stubSdb(launchAnswers());
  const fetchStub = stubFetch({ ...LIST, ...PROTOCOL });
  const connectStub = stubConnect();

  const attached = await attach(CONFIG, {
    _sdb: sdbStub,
    _fetch: fetchStub,
    _connect: connectStub,
    _sleep: instant,
    ...settledOptions,
  });

  assert.equal(attached.port, PORT);
  assert.deepEqual(attached.protocol, { domains: [{ domain: "Network" }] });
  assert.equal(connectStub.state.url, `ws://127.0.0.1:${PORT}/devtools/page/1`);
  assert.deepEqual(sdbStub.text(), [
    "devices",
    `shell 0 kill ${PKGID}`,
    `shell 0 debug ${APPID}`,
    `forward tcp:${PORT} tcp:${PORT}`,
  ]);
  assert.deepEqual(fetchStub.urls, [
    `http://127.0.0.1:${PORT}/json/list`,
    `http://127.0.0.1:${PORT}/json/protocol`,
  ]);
});

test("attach connects the TV first when sdb devices does not list it", async () => {
  let listings = 0;
  const sdbStub = stubSdb(
    launchAnswers({
      devices: () => ok(listings++ === 0 ? NO_DEVICES : DEVICES),
      [`connect ${HOST}`]: ok("connected"),
    }),
  );

  await attach(CONFIG, { _sdb: sdbStub, _fetch: stubFetch({ ...LIST, ...PROTOCOL }), _connect: stubConnect(), _sleep: instant, ...settledOptions });

  assert.deepEqual(sdbStub.text().slice(0, 3), ["devices", `connect ${HOST}`, "devices"]);
});

test("attach is inconclusive when the TV never appears", async () => {
  const sdbStub = stubSdb({ devices: ok(NO_DEVICES), [`connect ${HOST}`]: ok() });
  await assert.rejects(
    attach(CONFIG, { _sdb: sdbStub, _fetch: stubFetch({ ...LIST, ...PROTOCOL }), _connect: stubConnect(), _sleep: instant, ...settledOptions }),
    (error) => {
      assert.ok(error instanceof AttachInconclusive);
      assert.match(error.message, /developer mode/);
      return true;
    },
  );
  assert.deepEqual(sdbStub.text(), ["devices", `connect ${HOST}`, "devices"]);
});

test("no debug port within the bound leaves the attach inconclusive, and no forward behind", async () => {
  const sdbStub = stubSdb(launchAnswers({ [`shell 0 debug ${APPID}`]: { code: 2, stdout: "", stderr: "" } }));

  await assert.rejects(
    attach(CONFIG, { _sdb: sdbStub, _fetch: stubFetch({ ...LIST, ...PROTOCOL }), _connect: stubConnect(), _sleep: instant, ...settledOptions }),
    (error) => {
      assert.ok(error instanceof AttachInconclusive);
      assert.match(error.message, /press EXIT on the remote, then re-run/);
      return true;
    },
  );

  const debug = sdbStub.calls.find((entry) => entry.argv.join(" ") === `shell 0 debug ${APPID}`);
  assert.equal(debug.timeoutMs, 35000, "the debug launch is bounded at 35 s");
  assert.equal(sdbStub.calls.some((entry) => entry.argv[0] === "forward"), false);
  assert.equal(sdbStub.calls.some((entry) => entry.argv.join(" ") === `shell 0 kill ${PKGID}`), true);
});

test("a kill that fails is inconclusive and never launches", async () => {
  const sdbStub = stubSdb(
    launchAnswers({ [`shell 0 kill ${PKGID}`]: { code: 1, stdout: "General error [-1] failed", stderr: "" } }),
  );

  await assert.rejects(
    attach(CONFIG, { _sdb: sdbStub, _fetch: stubFetch({ ...LIST, ...PROTOCOL }), _connect: stubConnect(), _sleep: instant, ...settledOptions }),
    (error) => {
      assert.ok(error instanceof AttachInconclusive);
      assert.match(error.message, /press EXIT on the remote, then re-run/);
      return true;
    },
  );
  assert.equal(sdbStub.calls.some((entry) => entry.argv.includes("debug")), false);
});

test("detach after launch kills the package id, then removes the forward", async () => {
  const sdbStub = stubSdb(launchAnswers());
  const connectStub = stubConnect();
  const attached = await attach(CONFIG, {
    _sdb: sdbStub,
    _fetch: stubFetch({ ...LIST, ...PROTOCOL }),
    _connect: connectStub,
    _sleep: instant,
    ...settledOptions,
  });
  const launched = sdbStub.calls.length;

  await attached.detach();
  assert.deepEqual(sdbStub.text(launched), [`shell 0 kill ${PKGID}`, `forward --remove tcp:${PORT}`]);
  assert.equal(connectStub.state.closed, 1);

  await attached.detach();
  assert.equal(sdbStub.calls.length, launched + 2, "a second detach does nothing");
});

// Row 22: a stub clock, so the split between the relaunch and the whole attach is exact.
test("attach reports attachMs and the relaunch's share of it", async () => {
  let clock = 1000;
  const sdbStub = stubSdb(launchAnswers());
  const fetchStub = stubFetch({ ...LIST, ...PROTOCOL });
  const attached = await attach(CONFIG, {
    _sdb: async (...args) => { clock += 10; return sdbStub(...args); },
    _fetch: async (...args) => { clock += 5; return fetchStub(...args); },
    _connect: async () => { clock += 100; return { close() {} }; },
    _sleep: instant,
    _now: () => clock,
    ...settledOptions,
  });
  assert.deepEqual(attached.timings, { attachMs: 150, relaunchMs: 40 });
});

test("a join has no relaunch to time", async () => {
  let clock = 0;
  const attached = await attach(CONFIG, {
    attachPort: PORT,
    _sdb: stubSdb({ [`forward --remove tcp:${PORT}`]: ok() }),
    _fetch: async (...args) => { clock += 5; return stubFetch({ ...LIST, ...PROTOCOL })(...args); },
    _connect: async () => ({ close() {} }),
    _sleep: instant,
    _now: () => clock,
    ...settledOptions,
  });
  assert.deepEqual(attached.timings, { attachMs: 10, relaunchMs: null });
});

test("an attach-port join never kills the app and only removes the forward", async () => {
  const sdbStub = stubSdb({ [`forward --remove tcp:${PORT}`]: ok() });
  const attached = await attach(CONFIG, {
    attachPort: PORT,
    _sdb: sdbStub,
    _fetch: stubFetch({ ...LIST, ...PROTOCOL }),
    _connect: stubConnect(),
    _sleep: instant,
    ...settledOptions,
  });

  assert.equal(attached.port, PORT);
  assert.deepEqual(sdbStub.calls, [], "a join runs no sdb command");

  await attached.detach();
  assert.deepEqual(sdbStub.text(), [`forward --remove tcp:${PORT}`]);
});

test("a failed forward still closes the app it launched", async () => {
  const sdbStub = stubSdb(
    launchAnswers({
      [`forward tcp:${PORT} tcp:${PORT}`]: () => {
        throw new Error("sdb died");
      },
    }),
  );

  await assert.rejects(
    attach(CONFIG, { _sdb: sdbStub, _fetch: stubFetch({ ...LIST, ...PROTOCOL }), _connect: stubConnect(), _sleep: instant, ...settledOptions }),
    /sdb died/,
  );
  assert.deepEqual(sdbStub.text().slice(-2), [`shell 0 kill ${PKGID}`, `forward --remove tcp:${PORT}`]);
});

test("a failure after the forward cleans up the forward and the app it launched", async () => {
  const sdbStub = stubSdb(launchAnswers());
  const fetchStub = stubFetch({ "/json/list": [], ...PROTOCOL });

  await assert.rejects(
    attach(CONFIG, { _sdb: sdbStub, _fetch: fetchStub, _connect: stubConnect(), _sleep: instant, ...settledOptions }),
    (error) => {
      assert.ok(error instanceof AttachInconclusive);
      assert.match(error.message, /no page target/);
      return true;
    },
  );

  assert.deepEqual(sdbStub.text().slice(-2), [`shell 0 kill ${PKGID}`, `forward --remove tcp:${PORT}`]);
});

test("attach polls for the page target while the inspector comes up", async () => {
  let attempts = 0;
  const list = [
    () => [],
    () => [],
    () => [{ type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/1` }],
  ];
  const fetchStub = async (url) => {
    if (new URL(url).pathname !== "/json/list") return { ok: true, json: async () => ({ domains: [] }) };
    return { ok: true, json: async () => list[Math.min(attempts++, list.length - 1)]() };
  };

  const attached = await attach(CONFIG, {
    _sdb: stubSdb(launchAnswers()),
    _fetch: fetchStub,
    _connect: stubConnect(),
    _sleep: instant,
    ...settledOptions,
  });
  assert.equal(attached.port, PORT);
  assert.equal(attempts, 3);
});

test("a protocol the target will not serve leaves protocol null instead of failing the attach", async () => {
  const attached = await attach(CONFIG, {
    _sdb: stubSdb(launchAnswers()),
    _fetch: stubFetch(LIST),
    _connect: stubConnect(),
    _sleep: instant,
    ...settledOptions,
  });
  assert.equal(attached.protocol, null);
});

// The widget runs a bootstrap document that redirects to `content src`; a decision taken on the
// first one is taken on a page the user never sees.
test("attach waits through a redirect and returns the page it settled on", async () => {
  let polls = 0;
  let clock = 0;
  const evaluateStub = async () => {
    polls += 1;
    return polls <= 3
      ? { href: "http://127.0.0.1/index.html", origin: "http://127.0.0.1", ready: "complete", hasBody: true }
      : SETTLED;
  };

  const attached = await attach(CONFIG, {
    _sdb: stubSdb(launchAnswers()),
    _fetch: stubFetch({ ...LIST, ...PROTOCOL }),
    _connect: stubConnect(),
    _evaluate: evaluateStub,
    _sleep: async () => { clock += 100; },
    _now: () => clock,
  });

  assert.equal(attached.settled.href, SETTLED.href);
  assert.equal(attached.settled.origin, SETTLED.origin);
  assert.ok(polls >= 18, `the settled href must hold 1.5 s before the attach returns: ${polls} polls`);
});

test("an attach-port join waits for the page it joined to settle too", async () => {
  let polls = 0;
  let clock = 0;
  const attached = await attach(CONFIG, {
    attachPort: PORT,
    _sdb: stubSdb({ [`forward --remove tcp:${PORT}`]: ok() }),
    _fetch: stubFetch({ ...LIST, ...PROTOCOL }),
    _connect: stubConnect(),
    _evaluate: async () => { polls += 1; return SETTLED; },
    _sleep: async () => { clock += 100; },
    _now: () => clock,
  });

  assert.equal(attached.settled.href, SETTLED.href);
  assert.ok(polls >= 15, `a join runs the same hold: ${polls} polls`);
});

test("a page that never settles leaves the attach inconclusive naming the last href", async () => {
  let polls = 0;
  let clock = 0;
  const sdbStub = stubSdb(launchAnswers());

  await assert.rejects(
    attach(CONFIG, {
      _sdb: sdbStub,
      _fetch: stubFetch({ ...LIST, ...PROTOCOL }),
      _connect: stubConnect(),
      _evaluate: async () => {
        polls += 1;
        return { href: `http://127.0.0.1/loading-${polls}.html`, origin: "http://127.0.0.1", ready: "loading", hasBody: true };
      },
      _sleep: async () => { clock += 100; },
      _now: () => clock,
    }),
    (error) => {
      assert.ok(error instanceof AttachInconclusive);
      assert.match(error.message, /did not settle/);
      assert.match(error.message, new RegExp(`loading-${polls}\\.html`), "the last href is named");
      return true;
    },
  );

  assert.deepEqual(sdbStub.text().slice(-2), [`shell 0 kill ${PKGID}`, `forward --remove tcp:${PORT}`],
    "a page that never settles leaves nothing behind");
});

test("a document with no body yet is waited out, not read", async () => {
  let polls = 0;
  let clock = 0;
  const attached = await attach(CONFIG, {
    _sdb: stubSdb(launchAnswers()),
    _fetch: stubFetch({ ...LIST, ...PROTOCOL }),
    _connect: stubConnect(),
    _evaluate: async () => {
      polls += 1;
      return { ...SETTLED, hasBody: polls > 4 };
    },
    _sleep: async () => { clock += 100; },
    _now: () => clock,
  });

  assert.equal(attached.settled.href, SETTLED.href);
  assert.ok(polls > 10, `the body had to appear before the hold began: ${polls} polls`);
});

test("a settle that never completes closes the socket it opened", async () => {
  let polls = 0;
  let clock = 0;
  const connectStub = stubConnect();

  await assert.rejects(
    attach(CONFIG, {
      _sdb: stubSdb(launchAnswers()),
      _fetch: stubFetch({ ...LIST, ...PROTOCOL }),
      _connect: connectStub,
      _evaluate: async () => {
        polls += 1;
        return { href: `http://127.0.0.1/loading-${polls}.html`, origin: "http://127.0.0.1", ready: "loading", hasBody: true };
      },
      _sleep: async () => { clock += 100; },
      _now: () => clock,
    }),
    AttachInconclusive,
  );

  assert.equal(connectStub.state.closed, 1, "the inspector socket does not outlive a failed attach");
});

test("attach without tv.host and tv.appid names both config keys", async () => {
  await assert.rejects(attach({ tv: { host: HOST } }, {}), /tv\.host and tv\.appid/);
  await assert.rejects(attach({}, {}), /tv\.host and tv\.appid/);
});
