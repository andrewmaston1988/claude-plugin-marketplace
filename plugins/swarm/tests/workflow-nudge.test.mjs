import { test } from "node:test";
import assert from "node:assert/strict";
import { decideNudge, nudgeReason } from "../hooks/workflow-nudge.mjs";

const ARMED = { provider: { allowedRoots: ["C:/personal"] } };

test("nudges the first Workflow call of a session when armed", () => {
  assert.equal(decideNudge({ config: ARMED, seen: null, sessionId: "s1" }), true);
});

test("does not repeat within a session", () => {
  assert.equal(decideNudge({ config: ARMED, seen: { s1: 123 }, sessionId: "s1" }), false);
  assert.equal(decideNudge({ config: ARMED, seen: { s1: 123 }, sessionId: "s2" }), true);
});

test("silent when not armed (no allowedRoots) — Workflow is the only game", () => {
  assert.equal(decideNudge({ config: { provider: { allowedRoots: [] } }, seen: null, sessionId: "s1" }), false);
  assert.equal(decideNudge({ config: null, seen: null, sessionId: "s1" }), false);
});

test("silent for pipeline children and when disabled", () => {
  assert.equal(decideNudge({ config: ARMED, seen: null, sessionId: "s1", correlationId: "corr-1" }), false);
  assert.equal(decideNudge({ config: { ...ARMED, swarm: { workflowNudge: false } }, seen: null, sessionId: "s1" }), false);
  assert.equal(decideNudge({ config: ARMED, seen: null, sessionId: "" }), false);
});

test("reason mentions swarm, the retry escape hatch, and once-per-session", () => {
  const r = nudgeReason();
  assert.match(r, /swarm/i);
  assert.match(r, /call Workflow again/i);
  assert.match(r, /once per session/i);
});

// The nudge asks "is the ALTERNATIVE-model path armed?" — Claude is excluded, so claude's
// own roots must not arm it. Unifying this with the run gate is the naive-collapse bug.
test("not armed when only claude has roots", () => {
  const cfg = { providers: { claude: { enabled: true, allowedRoots: ["C:/personal"] }, ollama: { enabled: true } } };
  assert.equal(decideNudge({ config: cfg, seen: null, sessionId: "s1" }), false);
});

test("armed when a non-Claude provider inherits the top-level list", () => {
  const cfg = { allowedRoots: ["C:/personal"], providers: { claude: { enabled: true }, ollama: { enabled: true } } };
  assert.equal(decideNudge({ config: cfg, seen: null, sessionId: "s1" }), true);
  // Raw config.json, no defaults merge — a top-level key alone still arms the shipped providers.
  assert.equal(decideNudge({ config: { allowedRoots: ["C:/personal"] }, seen: null, sessionId: "s1" }), true);
});
