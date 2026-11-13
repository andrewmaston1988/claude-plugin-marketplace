import { test } from "node:test";
import assert from "node:assert/strict";
import { installFetchGuard, installGuard, interceptionKind, isWrite, tvWritePolicy } from "../src/guard.mjs";

function stubCdp() {
  const calls = [];
  const handlers = new Map();
  return {
    calls,
    handlers,
    async send(method, params = {}) {
      calls.push({ method, params });
      return {};
    },
    on(method, fn) {
      handlers.set(method, [...(handlers.get(method) || []), fn]);
      return () => handlers.set(method, (handlers.get(method) || []).filter((f) => f !== fn));
    },
    async fire(method, params) {
      for (const fn of handlers.get(method) || []) await fn(params);
    },
    methods() { return calls.map((call) => call.method); },
  };
}

// The 39-domain shape the set answers with: Network carries the M69 interception commands, Fetch is absent.
const TV_PROTOCOL = {
  domains: [
    { domain: "Input", commands: [{ name: "dispatchKeyEvent" }] },
    { domain: "Page", commands: [{ name: "navigate" }] },
    {
      domain: "Network",
      commands: [{ name: "enable" }, { name: "setRequestInterception" }, { name: "continueInterceptedRequest" }],
    },
  ],
};

const MODERN_PROTOCOL = {
  domains: [
    { domain: "Fetch", commands: [{ name: "enable" }, { name: "failRequest" }] },
    { domain: "Network", commands: [{ name: "enable" }] },
  ],
};

const intercepted = (method, url, interceptionId = "int-1") => ({
  interceptionId,
  request: { method, url },
  resourceType: "XHR",
});

const testOrigin = "http://127.0.0.1:8001";

test("interceptionKind reads the protocol's domains", () => {
  assert.equal(interceptionKind(MODERN_PROTOCOL), "fetch");
  assert.equal(interceptionKind(TV_PROTOCOL), "network");
  assert.equal(interceptionKind(null), "fetch");
  assert.equal(interceptionKind({ domains: [{ domain: "Page" }] }), null);
});

// Row 5
test("a protocol with Fetch installs the phase 1 Fetch guard and nothing else", async () => {
  const cdp = stubCdp();
  const guard = await installGuard(cdp, MODERN_PROTOCOL);
  assert.deepEqual(cdp.calls, [
    { method: "Fetch.enable", params: { patterns: [{ urlPattern: "*", requestStage: "Request" }] } },
  ]);
  assert.equal(cdp.handlers.has("Network.requestIntercepted"), false);
  assert.deepEqual(guard.blocked, []);
  await guard.uninstall();
});

test("a missing protocol takes the Fetch path, so a browser attach is unchanged", async () => {
  const cdp = stubCdp();
  const guard = await installGuard(cdp, null);
  assert.equal(cdp.methods().includes("Fetch.enable"), true);
  assert.equal(cdp.methods().includes("Network.setRequestInterception"), false);
  await guard.uninstall();
});

// Row 5
test("a protocol without Fetch installs Network interception at the request stage", async () => {
  const cdp = stubCdp();
  const guard = await installGuard(cdp, TV_PROTOCOL);
  assert.deepEqual(cdp.calls.at(-1), {
    method: "Network.setRequestInterception",
    params: { patterns: [{ urlPattern: "*", interceptionStage: "Request" }] },
  });
  assert.equal(cdp.handlers.get("Network.requestIntercepted").length, 1);
  assert.equal(cdp.handlers.has("Fetch.requestPaused"), false);
  assert.deepEqual(guard.blocked, []);
});

// Row 5
test("the Network guard aborts a write with BlockedByClient and records it, and lets a read through", async () => {
  const cdp = stubCdp();
  const guard = await installGuard(cdp, TV_PROTOCOL);

  await cdp.fire("Network.requestIntercepted", intercepted("POST", "http://192.0.2.30:8000/tv/api/session"));
  assert.deepEqual(guard.blocked.map((entry) => `${entry.method} ${entry.url}`), [
    "POST http://192.0.2.30:8000/tv/api/session",
  ]);
  assert.deepEqual(cdp.calls.at(-1), {
    method: "Network.continueInterceptedRequest",
    params: { interceptionId: "int-1", errorReason: "BlockedByClient" },
  });

  await cdp.fire("Network.requestIntercepted", intercepted("GET", "http://192.0.2.30:8000/tv", "int-2"));
  assert.deepEqual(cdp.calls.at(-1), {
    method: "Network.continueInterceptedRequest",
    params: { interceptionId: "int-2" },
  });
  assert.equal(guard.blocked.length, 1);
});

test("uninstall stops the Network listener and clears the patterns", async () => {
  const cdp = stubCdp();
  const guard = await installGuard(cdp, TV_PROTOCOL);
  await guard.uninstall();
  assert.equal(cdp.handlers.get("Network.requestIntercepted").length, 0);
  assert.deepEqual(cdp.calls.at(-1), { method: "Network.setRequestInterception", params: { patterns: [] } });
});

test("a failed Network interception setup leaves no listener behind", async () => {
  const cdp = stubCdp();
  const send = cdp.send.bind(cdp);
  cdp.send = async (method, params) => {
    if (method === "Network.setRequestInterception") throw new Error("setRequestInterception refused");
    return send(method, params);
  };
  await assert.rejects(installGuard(cdp, TV_PROTOCOL), /setRequestInterception refused/);
  assert.equal((cdp.handlers.get("Network.requestIntercepted") || []).length, 0);
});

// Row 6 (the guard half)
test("with --allow-writes a TV write to tv.testOrigin continues and one elsewhere is still blocked", async () => {
  const cdp = stubCdp();
  const guard = await installGuard(cdp, TV_PROTOCOL, {
    allowWrites: true,
    testOrigin,
    backend: "tv",
  });

  await cdp.fire("Network.requestIntercepted", intercepted("POST", `${testOrigin}/tv/api/session`, "int-test"));
  assert.deepEqual(cdp.calls.at(-1), {
    method: "Network.continueInterceptedRequest",
    params: { interceptionId: "int-test" },
  });
  assert.equal(guard.blocked.length, 0);

  await cdp.fire("Network.requestIntercepted", intercepted("POST", "http://192.0.2.30:8000/tv/api/session", "int-prod"));
  assert.deepEqual(cdp.calls.at(-1), {
    method: "Network.continueInterceptedRequest",
    params: { interceptionId: "int-prod", errorReason: "BlockedByClient" },
  });
  assert.deepEqual(guard.blocked.map((entry) => `${entry.method} ${entry.url}`), [
    "POST http://192.0.2.30:8000/tv/api/session",
  ]);
});

test("an allowWrites TV guard with no testOrigin blocks every write", async () => {
  const cdp = stubCdp();
  const guard = await installGuard(cdp, TV_PROTOCOL, { allowWrites: true, backend: "tv" });
  await cdp.fire("Network.requestIntercepted", intercepted("POST", "http://127.0.0.1:8001/tv/api/session"));
  assert.equal(guard.blocked.length, 1);
  assert.equal(cdp.calls.at(-1).params.errorReason, "BlockedByClient");
});

test("without --allow-writes a TV guard blocks a write even on the test origin", async () => {
  const cdp = stubCdp();
  const guard = await installGuard(cdp, TV_PROTOCOL, { testOrigin, backend: "tv" });
  await cdp.fire("Network.requestIntercepted", intercepted("POST", `${testOrigin}/tv/api/session`));
  assert.equal(guard.blocked.length, 1);
  assert.equal(cdp.calls.at(-1).params.errorReason, "BlockedByClient");
});

// Row 7
test("tvWritePolicy passes a non-TV backend through untouched", () => {
  assert.equal(tvWritePolicy({ backend: "browser", hasInterception: false }), null);
  assert.equal(tvWritePolicy({ backend: null, allowWrites: true }), null);
});

test("tvWritePolicy refuses a TV run that has no interception and no --allow-writes", () => {
  const message = tvWritePolicy({ backend: "tv", hasInterception: false, allowWrites: false, testOrigin });
  assert.match(message, /--allow-writes/);
  assert.match(message, /interception/);
});

test("tvWritePolicy refuses --allow-writes when tv.testOrigin is unset", () => {
  for (const hasInterception of [true, false]) {
    const message = tvWritePolicy({ backend: "tv", hasInterception, allowWrites: true, testOrigin: null });
    assert.match(message, /tv\.testOrigin/, String(hasInterception));
  }
});

test("tvWritePolicy refuses a TV open outside tv.testOrigin when no interception is available", () => {
  for (const open of [
    "http://192.0.2.30:8000/tv",
    { url: "http://192.0.2.30:8000/tv" },
    { open: { url: "http://192.0.2.30:8000/tv" } },
    { open: "http://192.0.2.30:8000/tv" },
  ]) {
    const message = tvWritePolicy({ backend: "tv", hasInterception: false, allowWrites: true, testOrigin, opens: [open] });
    assert.match(message, /192\.0\.2\.30:8000/, JSON.stringify(open));
    assert.match(message, /tv\.testOrigin/, JSON.stringify(open));
  }
});

test("tvWritePolicy allows a TV run whose opens are all on tv.testOrigin", () => {
  assert.equal(tvWritePolicy({
    backend: "tv",
    hasInterception: false,
    allowWrites: true,
    testOrigin,
    opens: [`${testOrigin}/tv`, { open: { url: `${testOrigin}/tv?tizen=1` } }],
  }), null);
});

test("tvWritePolicy allows a TV run that has interception, and one with no opens", () => {
  assert.equal(tvWritePolicy({ backend: "tv", hasInterception: true, allowWrites: false, testOrigin }), null);
  assert.equal(tvWritePolicy({ backend: "tv", hasInterception: false, allowWrites: true, testOrigin, opens: [] }), null);
});

test("isWrite is the one predicate the TV guard uses", () => {
  assert.equal(isWrite("POST"), true);
  assert.equal(isWrite("GET"), false);
});

test("installFetchGuard is still exported with its phase 1 signature", async () => {
  const cdp = stubCdp();
  const guard = await installFetchGuard(cdp, { allowWrites: true });
  assert.deepEqual(cdp.calls, []);
  assert.deepEqual(guard.blocked, []);
});
