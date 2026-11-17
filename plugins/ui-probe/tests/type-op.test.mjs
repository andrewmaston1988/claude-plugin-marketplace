// The type op: schema rows, and browser rows against /type.html. With no Chromium browser the
// browser rows skip; UI_PROBE_REQUIRE_BROWSER=1 turns that skip into a failure.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { startFixtureServer } from "./fixtures/server.mjs";
import { findBrowser, launch } from "../src/browser.mjs";
import { evaluate } from "../src/cdp.mjs";
import { run } from "../src/runner.mjs";
import { OPS, validate } from "../src/ir.mjs";
import { stubCdp } from "./tv-support.mjs";

const REQUIRED = process.env.UI_PROBE_REQUIRE_BROWSER === "1";
const OVERRIDE = process.env.UI_PROBE_BROWSER || undefined;

let browserPath = null;
let browserProblem = null;
try {
  browserPath = findBrowser({ browser: OVERRIDE });
} catch (error) {
  browserProblem = error.message;
}

const SKIP = browserPath ? false : `${browserProblem} (set UI_PROBE_REQUIRE_BROWSER=1 to fail instead of skip)`;

let server;
let browser;
let client;

const runOn = (steps, ctx = {}) => run({ id: "type", steps }, { cdp: client, baseUrl: server.origin, ...ctx });
const page = (path, ...rest) => [{ open: { url: path } }, ...rest];

before(async () => {
  server = await startFixtureServer();
  if (browserPath) {
    browser = await launch({ browser: browserPath });
    client = await browser.attachPage();
  }
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

if (!browserPath && REQUIRED) {
  test("a Chromium browser is required but was not found", () => {
    assert.fail(`UI_PROBE_REQUIRE_BROWSER=1 and ${browserProblem}`);
  });
}

test("row 1: type requires a non-empty text and a non-negative gapMs, and guards the target like every op", () => {
  assert.equal(OPS.type.target, true);
  assert.deepEqual(validate({ id: "type", steps: [{ type: { text: "abc", target: "#field", gapMs: 50 } }] }), []);
  assert.deepEqual(validate({ id: "type", steps: [{ type: { text: "abc" } }] }), []);

  const bad = (step, field) => {
    const problems = validate({ id: "type", steps: [step] });
    const hit = problems.find((item) => item.field === field);
    assert.ok(hit && hit.problem && hit.fix && hit.example, `${JSON.stringify(step)}: ${JSON.stringify(problems)}`);
  };
  bad({ type: {} }, "steps[0].type.text");
  bad({ type: { text: 123 } }, "steps[0].type.text");
  bad({ type: { text: "abc", gapMs: -1 } }, "steps[0].type.gapMs");
  bad({ type: { text: "abc", speed: 1 } }, "steps[0].type.speed");
  bad({ type: { text: "abc", target: "" } }, "steps[0].type.target");
  bad({ type: { text: "abc", target: "role=textbox" } }, "steps[0].type.target");
});

test("rows 2-3: type focuses an unfocused target, fires one input event per character, and measures the value", { skip: SKIP }, async () => {
  const result = await runOn(page("/type.html",
    { type: { target: "#field", text: "abc" } },
    { expect_text: { target: "#count", equals: "3", timeoutMs: 0 } }));

  assert.equal(result.outcome, "passed", JSON.stringify(result.steps));
  assert.equal(result.steps[1].measured, "abc");

  // The page starts unfocused: without the focus call the characters land nowhere.
  const stillFocused = await runOn(page("/type.html", { type: { target: "#field", text: "z" } }), { requireAssertion: false });
  assert.equal(stillFocused.steps[1].measured, "z", JSON.stringify(stillFocused.steps));
});

test("row 4: a target matching nothing fails not_found and one matching two fails ambiguous_target", { skip: SKIP }, async () => {
  const missing = await runOn(page("/type.html", { type: { target: "#nope", text: "a" } }), { requireAssertion: false });
  assert.equal(missing.steps[1].failure, "not_found", JSON.stringify(missing.steps));

  const ambiguous = await runOn(page("/type.html", { type: { target: ".pair", text: "a" } }), { requireAssertion: false });
  assert.equal(ambiguous.steps[1].failure, "ambiguous_target", JSON.stringify(ambiguous.steps));
});

test("row 5: a non-focusable target fails focus_failed instead of typing nowhere", { skip: SKIP }, async () => {
  const result = await runOn(page("/type.html", { type: { target: "#plain", text: "abc" } }), { requireAssertion: false });
  assert.equal(result.steps[1].failure, "focus_failed", JSON.stringify(result.steps));
});

test("row 6: with no target, type types into the element the page focused", { skip: SKIP }, async () => {
  const result = await runOn(page("/type.html",
    { click: { target: "#field" } },
    { type: { text: "hi" } },
    { expect_text: { target: "#count", equals: "2", timeoutMs: 0 } }));

  assert.equal(result.outcome, "passed", JSON.stringify(result.steps));
  assert.equal(result.steps[2].measured, "hi");
});

test("row 10: no target and nothing editable focused fails focus_failed and fires no input event", { skip: SKIP }, async () => {
  const result = await runOn(page("/type.html", { type: { text: "abc" } }), { requireAssertion: false });
  assert.equal(result.steps[1].failure, "focus_failed", JSON.stringify(result.steps));

  const fired = await evaluate(client, "document.getElementById('count').textContent");
  assert.equal(fired, "0", "the page counted an input event with nothing editable focused");
});

test("row 11: typing into a contenteditable measures its textContent", { skip: SKIP }, async () => {
  const result = await runOn(page("/type.html", { type: { target: "#editable", text: "hi" } }), { requireAssertion: false });
  assert.equal(result.outcome, "passed", JSON.stringify(result.steps));
  assert.equal(result.steps[1].measured, "hi", JSON.stringify(result.steps));
});

test("row 7: gapMs spaces the gaps between characters, so three characters wait twice", async () => {
  const slept = [];
  const cdp = stubCdp({
    replies: [
      { match: (expression) => expression.includes("el.focus()"), value: true },
      { match: (expression) => expression.includes("isContentEditable"), value: { editable: true, value: "abc" } },
    ],
    onSend: (method) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelectorAll") return { nodeIds: [2] };
      return undefined;
    },
  });
  const guard = { blocked: [], uninstall: async () => {} };
  const result = await run({
    id: "type",
    steps: [{ type: { target: "#field", text: "abc", gapMs: 50 } }],
  }, { cdp, guard, requireAssertion: false, _sleep: async (ms) => { slept.push(ms); } });

  assert.equal(result.outcome, "passed", JSON.stringify(result.steps));
  assert.deepEqual(slept, [50, 50]);
  assert.deepEqual(cdp.sent("Input.insertText").map((call) => call.params.text), ["a", "b", "c"]);
  assert.equal(result.steps[0].measured, "abc");
});
