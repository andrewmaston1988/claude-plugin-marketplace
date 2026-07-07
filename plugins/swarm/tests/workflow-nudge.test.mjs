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
