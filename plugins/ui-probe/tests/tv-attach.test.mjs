import { test } from "node:test";
import assert from "node:assert/strict";
import { attach, AttachInconclusive } from "../src/tv/attach.mjs";

const HOST = "192.168.1.110:26101";
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

test("attach connects, closes, launches, forwards, then reads the page target and protocol", async () => {
  const sdbStub = stubSdb(launchAnswers());
  const fetchStub = stubFetch({ ...LIST, ...PROTOCOL });
  const connectStub = stubConnect();

  const attached = await attach(CONFIG, {
    _sdb: sdbStub,
    _fetch: fetchStub,
    _connect: connectStub,
    _sleep: instant,
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

  await attach(CONFIG, { _sdb: sdbStub, _fetch: stubFetch({ ...LIST, ...PROTOCOL }), _connect: stubConnect(), _sleep: instant });

  assert.deepEqual(sdbStub.text().slice(0, 3), ["devices", `connect ${HOST}`, "devices"]);
});

test("attach is inconclusive when the TV never appears", async () => {
  const sdbStub = stubSdb({ devices: ok(NO_DEVICES), [`connect ${HOST}`]: ok() });
  await assert.rejects(
    attach(CONFIG, { _sdb: sdbStub, _fetch: stubFetch({ ...LIST, ...PROTOCOL }), _connect: stubConnect(), _sleep: instant }),
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
    attach(CONFIG, { _sdb: sdbStub, _fetch: stubFetch({ ...LIST, ...PROTOCOL }), _connect: stubConnect(), _sleep: instant }),
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
    attach(CONFIG, { _sdb: sdbStub, _fetch: stubFetch({ ...LIST, ...PROTOCOL }), _connect: stubConnect(), _sleep: instant }),
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
  });
  const launched = sdbStub.calls.length;

  await attached.detach();
  assert.deepEqual(sdbStub.text(launched), [`shell 0 kill ${PKGID}`, `forward --remove tcp:${PORT}`]);
  assert.equal(connectStub.state.closed, 1);

  await attached.detach();
  assert.equal(sdbStub.calls.length, launched + 2, "a second detach does nothing");
});

test("an attach-port join never kills the app and only removes the forward", async () => {
  const sdbStub = stubSdb({ [`forward --remove tcp:${PORT}`]: ok() });
  const attached = await attach(CONFIG, {
    attachPort: PORT,
    _sdb: sdbStub,
    _fetch: stubFetch({ ...LIST, ...PROTOCOL }),
    _connect: stubConnect(),
    _sleep: instant,
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
    attach(CONFIG, { _sdb: sdbStub, _fetch: stubFetch({ ...LIST, ...PROTOCOL }), _connect: stubConnect(), _sleep: instant }),
    /sdb died/,
  );
  assert.deepEqual(sdbStub.text().slice(-2), [`shell 0 kill ${PKGID}`, `forward --remove tcp:${PORT}`]);
});

test("a failure after the forward cleans up the forward and the app it launched", async () => {
  const sdbStub = stubSdb(launchAnswers());
  const fetchStub = stubFetch({ "/json/list": [], ...PROTOCOL });

  await assert.rejects(
    attach(CONFIG, { _sdb: sdbStub, _fetch: fetchStub, _connect: stubConnect(), _sleep: instant }),
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
  });
  assert.equal(attached.protocol, null);
});

test("attach without tv.host and tv.appid names both config keys", async () => {
  await assert.rejects(attach({ tv: { host: HOST } }, {}), /tv\.host and tv\.appid/);
  await assert.rejects(attach({}, {}), /tv\.host and tv\.appid/);
});
