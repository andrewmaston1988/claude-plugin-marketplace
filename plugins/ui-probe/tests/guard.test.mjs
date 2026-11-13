import { test } from "node:test";
import assert from "node:assert/strict";
import { actionAllowed, installFetchGuard, isWrite } from "../src/guard.mjs";

function stubCdp({ evaluateValue } = {}) {
  const calls = [];
  const handlers = new Map();
  return {
    calls,
    handlers,
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") return { result: { value: evaluateValue } };
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

const paused = (method, url = "http://127.0.0.1:8001/recommend/action") => ({
  requestId: "req-1",
  request: { method, url },
});

test("isWrite allows reads and refuses everything that can carry a payload", () => {
  for (const method of ["GET", "HEAD", "OPTIONS", "get", "head"]) assert.equal(isWrite(method), false, method);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "post", "delete"]) assert.equal(isWrite(method), true, method);
});

test("the Fetch guard aborts a write and records it, and lets a read through", async () => {
  const cdp = stubCdp();
  const guard = installFetchGuard(cdp);
  assert.deepEqual(cdp.calls[0], {
    method: "Fetch.enable",
    params: { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
  });

  await cdp.fire("Fetch.requestPaused", paused("POST"));
  assert.deepEqual(guard.blocked.map((entry) => `${entry.method} ${entry.url}`), [
    "POST http://127.0.0.1:8001/recommend/action",
  ]);
  assert.deepEqual(cdp.calls.at(-1), { method: "Fetch.failRequest", params: { requestId: "req-1", errorReason: "BlockedByClient" } });

  await cdp.fire("Fetch.requestPaused", { requestId: "req-2", request: { method: "GET", url: "http://x/a" } });
  assert.deepEqual(cdp.calls.at(-1), { method: "Fetch.continueRequest", params: { requestId: "req-2" } });
  assert.equal(guard.blocked.length, 1);
});

test("allowWrites installs no interception at all", async () => {
  const cdp = stubCdp();
  const guard = installFetchGuard(cdp, { allowWrites: true });
  assert.deepEqual(cdp.calls, []);
  assert.equal(cdp.handlers.size, 0);
  assert.deepEqual(guard.blocked, []);
  await guard.uninstall();
});

test("uninstall stops the listener and disables Fetch", async () => {
  const cdp = stubCdp();
  const guard = installFetchGuard(cdp);
  await guard.uninstall();
  assert.equal(cdp.handlers.get("Fetch.requestPaused").length, 0);
  assert.equal(cdp.calls.at(-1).method, "Fetch.disable");
});

test("a blocked list owned by the caller is filled in place", async () => {
  const blocked = [];
  const cdp = stubCdp();
  installFetchGuard(cdp, { blocked });
  await cdp.fire("Fetch.requestPaused", paused("PATCH"));
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].method, "PATCH");
});

test("an action on a GET form or a plain link is allowed", async () => {
  for (const value of [
    { found: true, method: "GET", url: "/media/603" },
    { found: true, method: "GET", url: null },
  ]) {
    const cdp = stubCdp({ evaluateValue: value });
    const verdict = await actionAllowed(cdp, "[data-testid=close]");
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.method, "GET");
  }
});

test("an action that submits a form is refused before any input is sent", async () => {
  const cdp = stubCdp({ evaluateValue: { found: true, method: "POST", url: "/recommend/action" } });
  const verdict = await actionAllowed(cdp, ".detail-rec .act");
  assert.deepEqual(verdict, { allowed: false, found: true, method: "POST", url: "/recommend/action" });
});

test("a target that is not on the page is never allowed through", async () => {
  const cdp = stubCdp({ evaluateValue: { found: false } });
  const verdict = await actionAllowed(cdp, "#gone");
  assert.deepEqual(verdict, { allowed: false, found: false, method: null, url: null });
});

test("the selector reaches the page as a literal, not as code", async () => {
  const cdp = stubCdp({ evaluateValue: { found: true, method: "GET", url: null } });
  await actionAllowed(cdp, 'a[href="x\\y"]');
  const expression = cdp.calls.find((call) => call.method === "Runtime.evaluate").params.expression;
  assert.ok(expression.includes('document.querySelector("a[href=\\"x\\\\y\\"]")'), expression);
});
