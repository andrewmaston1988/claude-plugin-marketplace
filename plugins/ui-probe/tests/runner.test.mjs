import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/runner.mjs";

const URL = "http://127.0.0.1:1/page.html";

function stubCdp({ nodeIds = [], widths = [], connected = true, obscured = { found: true, clear: true }, action = { found: true, method: "GET", url: null }, loadError = null } = {}) {
  const calls = [];
  const handlers = new Map();
  const fire = (method, params) => { for (const fn of handlers.get(method) || []) fn(params); };

  const answer = (expression) => {
    if (expression.includes("elementFromPoint")) return obscured;
    if (expression.includes("htmx")) return action;
    if (expression.includes("getPropertyValue")) return { found: true, value: "flex" };
    if (expression.includes("textContent")) return { found: true, value: "hello" };
    if (expression.includes("getBoundingClientRect")) {
      return nodeIds.length ? { found: true, display: "block", visibility: "visible", width: 111, height: 40 } : { found: false };
    }
    return null;
  };

  return {
    calls,
    handlers,
    methods: () => calls.map((call) => call.method),
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === "Page.navigate") {
        if (loadError) return { errorText: loadError };
        fire("Page.loadEventFired", {});
        return {};
      }
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelectorAll") return { nodeIds };
      if (method === "DOM.getBoxModel") {
        const index = nodeIds.indexOf(params.nodeId);
        const width = widths[index] ?? 111;
        const height = 40;
        const quad = [0, 0, width, 0, width, height, 0, height];
        return { model: { content: quad, border: quad, width, height } };
      }
      if (method === "DOM.resolveNode") return { object: { objectId: "obj-1" } };
      if (method === "Runtime.callFunctionOn") return { result: { value: connected } };
      if (method === "Runtime.evaluate") return { result: { value: answer(params.expression) } };
      return {};
    },
    on(method, fn) {
      handlers.set(method, [...(handlers.get(method) || []), fn]);
      return () => handlers.set(method, (handlers.get(method) || []).filter((entry) => entry !== fn));
    },
  };
}

const doc = (...steps) => ({ id: "t", steps });

test("0 matches gives not_found, and expect_hidden passes on the same selector", async () => {
  const cdp = stubCdp({ nodeIds: [] });
  const clicked = await run(doc({ open: { url: URL } }, { click: { target: "#gone" } }), { cdp, requireAssertion: false });
  assert.equal(clicked.outcome, "failed");
  assert.equal(clicked.exitCode, 1);
  assert.equal(clicked.steps[1].failure, "not_found");
  assert.equal(cdp.methods().includes("Input.dispatchMouseEvent"), false);

  const hidden = await run(doc({ open: { url: URL } }, { expect_hidden: { target: "#gone" } }), { cdp });
  assert.equal(hidden.outcome, "passed");
  assert.equal(hidden.steps[1].outcome, "passed");
});

test("two matches for an interaction give ambiguous_target", async () => {
  const cdp = stubCdp({ nodeIds: [2, 3] });
  const result = await run(doc({ open: { url: URL } }, { click: { target: ".tile" } }), { cdp, requireAssertion: false });
  assert.equal(result.steps[1].failure, "ambiguous_target");
  assert.equal(cdp.methods().includes("Input.dispatchMouseEvent"), false);
});

test("a node disconnected between resolution and dispatch gives stale_target", async () => {
  const cdp = stubCdp({ nodeIds: [2], connected: false });
  const result = await run(doc({ open: { url: URL } }, { click: { target: "#tile" } }), { cdp, requireAssertion: false });
  assert.equal(result.steps[1].failure, "stale_target");
  assert.equal(cdp.methods().includes("Input.dispatchMouseEvent"), false);
});

test("a target covered at its centre gives target_obscured", async () => {
  const cdp = stubCdp({ nodeIds: [2], obscured: { found: true, clear: false } });
  const result = await run(doc({ open: { url: URL } }, { click: { target: "#covered" } }), { cdp, requireAssertion: false });
  assert.equal(result.steps[1].failure, "target_obscured");
});

test("a click dispatches press and release at the element's centre", async () => {
  const cdp = stubCdp({ nodeIds: [2], widths: [100] });
  const result = await run(doc({ open: { url: URL } }, { click: { target: "#tile" } }), { cdp, requireAssertion: false });
  assert.equal(result.outcome, "passed");
  const dispatched = cdp.calls.filter((call) => call.method === "Input.dispatchMouseEvent");
  assert.deepEqual(dispatched.map((call) => call.params.type), ["mousePressed", "mouseReleased"]);
  assert.equal(dispatched[0].params.x, 50);
  assert.equal(dispatched[0].params.y, 20);
});

test("a hover sends one mouseMoved", async () => {
  const cdp = stubCdp({ nodeIds: [2] });
  await run(doc({ open: { url: URL } }, { hover: { target: "#tile" } }), { cdp, requireAssertion: false });
  const dispatched = cdp.calls.filter((call) => call.method === "Input.dispatchMouseEvent");
  assert.deepEqual(dispatched.map((call) => call.params.type), ["mouseMoved"]);
});

test("a click that would submit a non-GET form is refused before any input", async () => {
  const cdp = stubCdp({ nodeIds: [2], action: { found: true, method: "POST", url: "/recommend/action" } });
  const result = await run(doc({ open: { url: URL } }, { click: { target: "#submit" } }), { cdp, requireAssertion: false });
  assert.equal(result.steps[1].failure, "write_blocked");
  assert.equal(cdp.methods().includes("Input.dispatchMouseEvent"), false);
});

test("a failed step stops the run and later steps are not run", async () => {
  const cdp = stubCdp({ nodeIds: [] });
  const result = await run(doc({ open: { url: URL } }, { click: { target: "#gone" } }, { expect_text: { target: "h1", equals: "hello" } }), { cdp });
  assert.deepEqual(result.steps.map((step) => step.outcome), ["passed", "failed", "not_run"]);
  assert.equal(result.steps[2].ms, 0);
});

test("expect_widths reports the measured widths on a mismatch", async () => {
  const cdp = stubCdp({ nodeIds: [2, 3, 4], widths: [54, 55, 78] });
  const result = await run(doc({ open: { url: URL } }, { expect_widths: { target: ".tile", equals: [111, 111, 111], timeoutMs: 0 } }), { cdp });
  assert.equal(result.outcome, "failed");
  assert.deepEqual(result.steps[1].measured, [54, 55, 78]);
});

test("expect_json compares the value at path, and a wrong value is failed with measured", async () => {
  const body = { ok: true, nested: { value: 5 } };
  const _fetch = async () => ({ status: 200, json: async () => body });
  const right = await run({ id: "j", backend: "http", steps: [{ expect_json: { url: URL, path: "nested.value", equals: 5 } }] }, { _fetch });
  assert.equal(right.outcome, "passed");
  assert.equal(right.exitCode, 0);

  const wrong = await run({ id: "j", backend: "http", steps: [{ expect_json: { url: URL, path: "nested.value", equals: 6 } }] }, { _fetch });
  assert.equal(wrong.outcome, "failed");
  assert.equal(wrong.steps[0].measured, 5);
});

test("expect_json is inconclusive on a non-2xx and on a network error", async () => {
  const bad = await run({ id: "j", backend: "http", steps: [{ expect_json: { url: URL, path: "ok", equals: true } }] }, {
    _fetch: async () => ({ status: 500, json: async () => ({ ok: false }) }),
  });
  assert.equal(bad.outcome, "inconclusive");
  assert.equal(bad.exitCode, 2);

  const dead = await run({ id: "j", backend: "http", steps: [{ expect_json: { url: URL, path: "ok", equals: true } }] }, {
    _fetch: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(dead.outcome, "inconclusive");
});

test("a failed navigation is inconclusive", async () => {
  const cdp = stubCdp({ loadError: "net::ERR_CONNECTION_REFUSED" });
  const result = await run(doc({ open: { url: URL } }, { expect_text: { target: "h1", equals: "hello" } }), { cdp });
  assert.equal(result.outcome, "inconclusive");
  assert.deepEqual(result.steps.map((step) => step.outcome), ["inconclusive", "not_run"]);
});

test("an invalid document returns exit 64 and touches no browser", async () => {
  let connected = false;
  const result = await run({ id: "Bad Id", steps: [] }, { cdp: () => { connected = true; } });
  assert.equal(result.outcome, "invalid");
  assert.equal(result.exitCode, 64);
  assert.equal(connected, false);
});

test("a scenario with no assertion step is needs_review and never connects", async () => {
  let connected = false;
  const result = await run(doc({ open: { url: URL } }, { click: { target: "#tile" } }), { cdp: () => { connected = true; } });
  assert.equal(result.outcome, "needs_review");
  assert.equal(result.exitCode, 3);
  assert.equal(connected, false);
});

test("row 23: an interaction scrolls the target into view before the obscured check", async () => {
  const cdp = stubCdp({ nodeIds: [2] });
  const result = await run(doc({ open: { url: URL } }, { click: { target: "#deep" } }), { cdp, requireAssertion: false });
  assert.equal(result.outcome, "passed");
  const evaluated = cdp.calls.filter((call) => call.method === "Runtime.evaluate").map((call) => call.params.expression);
  const scrollAt = evaluated.findIndex((expression) => expression.includes("scrollIntoView"));
  const hitAt = evaluated.findIndex((expression) => expression.includes("elementFromPoint"));
  assert.ok(scrollAt >= 0, "no scrollIntoView was evaluated");
  assert.ok(scrollAt < hitAt, `scroll at ${scrollAt}, obscured check at ${hitAt}`);
});

test("row 24: a viewport step sends its dpr and defaults to 1", async () => {
  const dprOf = (cdp) => cdp.calls
    .filter((call) => call.method === "Emulation.setDeviceMetricsOverride")
    .map((call) => call.params.deviceScaleFactor);

  const dense = stubCdp({ nodeIds: [2] });
  const scaled = await run(doc({ viewport: { width: 390, height: 844, dpr: 3 } }, { expect_text: { target: "h1", equals: "hello" } }), { cdp: dense });
  assert.equal(scaled.outcome, "passed");
  assert.deepEqual(dprOf(dense), [3]);

  const plain = stubCdp({ nodeIds: [2] });
  await run(doc({ viewport: { width: 1280, height: 900 } }, { expect_text: { target: "h1", equals: "hello" } }), { cdp: plain });
  assert.deepEqual(dprOf(plain), [1]);
});

test("row 25: expect_json bounds its fetch, and an abort is inconclusive", { timeout: 5000 }, async () => {
  let options = null;
  const ok = await run({ id: "j", backend: "http", steps: [{ expect_json: { url: URL, path: "ok", equals: true } }] }, {
    _fetch: async (url, opts) => { options = opts; return { status: 200, json: async () => ({ ok: true }) }; },
  });
  assert.equal(ok.outcome, "passed");
  assert.ok(options?.signal instanceof AbortSignal, "no signal was passed to fetch");

  const aborted = await run({ id: "j", backend: "http", steps: [{ expect_json: { url: URL, path: "ok", equals: true } }] }, {
    fetchTimeoutMs: 20,
    _fetch: (url, opts) => new Promise((_, reject) => {
      if (!opts?.signal) return;
      opts.signal.addEventListener("abort", () => reject(new Error("The operation was aborted due to timeout")));
    }),
  });
  assert.equal(aborted.outcome, "inconclusive");
  assert.equal(aborted.exitCode, 2);
});

test("a step's source is the scenario name and its 1-based index", async () => {
  const cdp = stubCdp({ nodeIds: [2] });
  const result = await run(doc({ open: { url: URL } }, { expect_text: { target: "h1", equals: "hello" } }), { cdp, source: "t2-hover.yaml" });
  assert.deepEqual(result.steps.map((step) => step.source), ["t2-hover.yaml:1", "t2-hover.yaml:2"]);
});
