import { test } from "node:test";
import assert from "node:assert/strict";
import { decideNudge, nudgeReason } from "../hooks/workflow-nudge.mjs";
import { NUDGE_CAP } from "../hooks/nudge-count.mjs";

const ARMED = { provider: { allowedRoots: ["C:/personal"] } };

test("nudges a Workflow call of an armed session", () => {
  assert.equal(decideNudge({ config: ARMED, seen: null, sessionId: "s1" }), "nudge");
});

test(`budget is ${NUDGE_CAP} firings per session, then silent`, () => {
  const at = (n) => decideNudge({ config: ARMED, seen: { s1: { n, t: Date.now() } }, sessionId: "s1" });
  for (let n = 0; n < NUDGE_CAP; n += 1) assert.equal(at(n), "nudge");
  assert.equal(at(NUDGE_CAP), false);
  // Budget is per session.
  assert.equal(decideNudge({ config: ARMED, seen: { s1: { n: NUDGE_CAP } }, sessionId: "s2" }), "nudge");
});

// The marker file predates the budget; a bare timestamp is one firing, not a spent budget.
test("a legacy marker entry leaves the rest of the budget", () => {
  assert.equal(decideNudge({ config: ARMED, seen: { s1: 123 }, sessionId: "s1" }), NUDGE_CAP > 1 ? "nudge" : false);
});

test("silent when not armed (no allowedRoots) — Workflow is the only game", () => {
  assert.equal(decideNudge({ config: { provider: { allowedRoots: [] } }, seen: null, sessionId: "s1" }), false);
  assert.equal(decideNudge({ config: null, seen: null, sessionId: "s1" }), false);
});

test("standing mode hard blocks with no budget, and needs no session id to book one", () => {
  const spent = { s1: { n: 99, t: Date.now() } };
  assert.equal(decideNudge({ config: { ...ARMED, swarm: { always: true } }, seen: spent, sessionId: "s1" }), "block");
  assert.equal(decideNudge({ config: { ...ARMED, swarm: { always: true } }, seen: null, sessionId: "" }), "block");
});

// Roots are checked before standing mode: a session with nothing armed has nowhere to send
// the work, so a hard block would trap the fan-out with no tool left to run it.
test("standing mode is silent when nothing is armed", () => {
  assert.equal(decideNudge({ config: { swarm: { always: true } }, seen: null, sessionId: "s1" }), false);
  const claudeOnly = { providers: { claude: { enabled: true, allowedRoots: ["C:/personal"] } }, swarm: { always: true } };
  assert.equal(decideNudge({ config: claudeOnly, seen: null, sessionId: "s1" }), false);
});

test("silent for pipeline children and when disabled", () => {
  assert.equal(decideNudge({ config: ARMED, seen: null, sessionId: "s1", correlationId: "corr-1" }), false);
  assert.equal(decideNudge({ config: { ...ARMED, swarm: { workflowNudge: false } }, seen: null, sessionId: "s1" }), false);
  const off = { swarm: { workflowNudge: false, always: true } };
  assert.equal(decideNudge({ config: off, seen: null, sessionId: "s1" }), false);
  assert.equal(decideNudge({ config: ARMED, seen: null, sessionId: "" }), false);
});

test("reason mentions swarm, the retry escape hatch, and the budget", () => {
  const r = nudgeReason();
  assert.match(r, /swarm/i);
  assert.match(r, /call it again/i);
  assert.match(r, new RegExp(`${NUDGE_CAP}x per session`));
});

test("block reason says it is a wall and names the escape hatch", () => {
  const r = nudgeReason("block");
  assert.match(r, /hard block/i);
  assert.match(r, /will not pass/i);
  assert.match(r, /swarm\.workflowNudge: false/);
});

// The nudge asks "is the ALTERNATIVE-model path armed?" — Claude is excluded, so claude's
// own roots must not arm it. Unifying this with the run gate is the naive-collapse bug.
test("not armed when only claude has roots", () => {
  const cfg = { providers: { claude: { enabled: true, allowedRoots: ["C:/personal"] }, ollama: { enabled: true } } };
  assert.equal(decideNudge({ config: cfg, seen: null, sessionId: "s1" }), false);
});

test("armed when a non-Claude provider inherits the top-level list", () => {
  const cfg = { allowedRoots: ["C:/personal"], providers: { claude: { enabled: true }, ollama: { enabled: true } } };
  assert.equal(decideNudge({ config: cfg, seen: null, sessionId: "s1" }), "nudge");
  // Raw config.json, no defaults merge — a top-level key alone still arms the shipped providers.
  assert.equal(decideNudge({ config: { allowedRoots: ["C:/personal"] }, seen: null, sessionId: "s1" }), "nudge");
});
