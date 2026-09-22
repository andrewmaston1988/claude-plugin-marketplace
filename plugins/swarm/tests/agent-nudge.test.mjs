import { test } from "node:test";
import assert from "node:assert/strict";
import { decideNudge, nudgeReason } from "../hooks/agent-nudge.mjs";
import { NUDGE_CAP } from "../hooks/nudge-count.mjs";

const EXPLORE = { subagent_type: "Explore", prompt: "find the thing" };

test("nudges an Agent call that leaves model unpinned", () => {
  assert.equal(decideNudge({ config: {}, seen: null, sessionId: "s1", toolInput: EXPLORE }), "nudge");
  assert.equal(decideNudge({ config: {}, seen: null, sessionId: "s1", toolInput: {} }), "nudge");
});

// The whole point of the gate: a pinned model is the decision it wanted made, so it must
// never spend a budget slot, and must pass even under standing mode.
test("silent when model is pinned", () => {
  for (const model of ["fable", "haiku", "sonnet", "opus"]) {
    assert.equal(decideNudge({ config: {}, seen: null, sessionId: "s1", toolInput: { ...EXPLORE, model } }), false);
  }
  assert.equal(
    decideNudge({ config: { swarm: { always: true } }, seen: null, sessionId: "s1", toolInput: { model: "haiku" } }),
    false,
  );
  // Whitespace is not a decision.
  assert.equal(decideNudge({ config: {}, seen: null, sessionId: "s1", toolInput: { model: "  " } }), "nudge");
});

// Unlike the Workflow nudge, this does NOT gate on allowedRoots — fable and haiku are
// Claude models, so the burn is live with zero alternative providers configured.
test("fires with no provider armed at all", () => {
  assert.equal(decideNudge({ config: null, seen: null, sessionId: "s1", toolInput: EXPLORE }), "nudge");
  const claudeOnly = { providers: { claude: { enabled: true } } };
  assert.equal(decideNudge({ config: claudeOnly, seen: null, sessionId: "s1", toolInput: EXPLORE }), "nudge");
});

test(`budget is ${NUDGE_CAP} firings per session, then silent`, () => {
  const at = (n) => decideNudge({ config: {}, seen: { s1: { n, t: Date.now() } }, sessionId: "s1", toolInput: EXPLORE });
  for (let n = 0; n < NUDGE_CAP; n += 1) assert.equal(at(n), "nudge");
  assert.equal(at(NUDGE_CAP), false);
  assert.equal(at(NUDGE_CAP + 1), false);
  // Budget is per session.
  assert.equal(
    decideNudge({ config: {}, seen: { s1: { n: NUDGE_CAP, t: Date.now() } }, sessionId: "s2", toolInput: EXPLORE }),
    "nudge",
  );
});

test("standing mode hard blocks with no budget", () => {
  const cfg = { swarm: { always: true } };
  const spent = { s1: { n: 99, t: Date.now() } };
  assert.equal(decideNudge({ config: cfg, seen: spent, sessionId: "s1", toolInput: EXPLORE }), "block");
  // A hard block does not need a session id to attribute a budget to.
  assert.equal(decideNudge({ config: cfg, seen: null, sessionId: "", toolInput: EXPLORE }), "block");
});

test("silent for pipeline children and when disabled", () => {
  assert.equal(
    decideNudge({ config: {}, seen: null, sessionId: "s1", toolInput: EXPLORE, correlationId: "corr-1" }),
    false,
  );
  const off = { swarm: { agentNudge: false, always: true } };
  assert.equal(decideNudge({ config: off, seen: null, sessionId: "s1", toolInput: EXPLORE }), false);
  assert.equal(decideNudge({ config: {}, seen: null, sessionId: "", toolInput: EXPLORE }), false);
});

test("reason names the field, the fix and every model option", () => {
  const r = nudgeReason(EXPLORE);
  assert.match(r, /`model`/);
  for (const m of ["fable", "haiku", "sonnet", "opus"]) assert.match(r, new RegExp(m));
  assert.match(r, /Explore/);
  assert.match(r, new RegExp(`${NUDGE_CAP}x per session`));
  assert.match(r, /swarm/i);
});

test("block reason says it is a wall and names the escape hatch", () => {
  const r = nudgeReason(EXPLORE, "block");
  assert.match(r, /hard block/i);
  assert.match(r, /will not pass/i);
  assert.match(r, /swarm\.agentNudge: false/);
  assert.doesNotMatch(r, new RegExp(`${NUDGE_CAP}x per session`));
});

test("reason falls back to a generic agent type", () => {
  assert.match(nudgeReason({}), /general-purpose/);
});
