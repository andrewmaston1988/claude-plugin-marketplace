// run-swarm.test.mjs — driver contract, gate persistence, and the computed decisions.
//
// The driver owns the SESSION-side sequence: gate answered -> validated ->
// dispatched -> one liveness check -> digest read. The engine already resumes
// (src/scheduler.mjs is a DAG state machine); nothing here touches it.
import { test } from "node:test";
import { equal, deepEqual, ok, match } from "node:assert/strict";
import {
  banner,
  needInput,
  GATE_KEYS,
  gateAnswered,
  recordGate,
  inlineEstimate,
  livenessVerdict,
  routeFailure,
  captureResultsDir,
} from "./run-swarm.mjs";

// ── Exit-mode contract ───────────────────────────────────────────────────────
// Observed 2026-08-20: run-workflow.mjs --phase authoring exited 0 with zero
// output, matching none of its four documented outcomes and reading as success
// to any caller branching on them. Pinned so this driver cannot repeat it.

test("banner: a pause is never silent and carries the re-run command", () => {
  const out = banner("Gate", ["1. Ask"], "node run-swarm.mjs --gate-fanout yes");
  match(out, /PAUSE: Gate/);
  match(out, /RE-RUN EXACTLY/);
  match(out, /--gate-fanout yes/);
  ok(out.trim().length > 0);
});

test("needInput: one line of parseable JSON with a hint", () => {
  const out = needInput("manifest", "Which manifest?");
  equal(out.endsWith("\n"), true);
  equal(out.slice(0, -1).includes("\n"), false);
  const parsed = JSON.parse(out);
  equal(parsed.error, "missing_required_field");
  equal(parsed.field, "manifest");
  ok(String(parsed.hint ?? "").length > 0);
});

// ── Gate answers: presence, not truthiness ★ ─────────────────────────────────
// The known defect in run-workflow.mjs: an empty --plans-line is rejected because
// the check is `if (!state.meta[k])` rather than `if (k in state.meta)`, so the
// honest answer is unreachable and the pause loops forever. Do not copy it.

test("gateAnswered: false until all three keys are present", () => {
  equal(gateAnswered({}), false);
  equal(gateAnswered({ fanout: "yes" }), false);
  equal(gateAnswered({ fanout: "yes", mix: "as drafted" }), false);
  equal(gateAnswered({ fanout: "yes", mix: "as drafted", batching: "as proposed" }), true);
});

test("gateAnswered: an EMPTY answer is a real answer ★", () => {
  const meta = { fanout: "", mix: "", batching: "" };
  equal(gateAnswered(meta), true);
});

test("gateAnswered: a rejection is recorded, not treated as unanswered", () => {
  const meta = { fanout: "no", mix: "no", batching: "no" };
  equal(gateAnswered(meta), true);
});

test("recordGate: stores an empty string rather than dropping the key", () => {
  const meta = recordGate({}, "fanout", "");
  ok("fanout" in meta);
  equal(meta.fanout, "");
});

test("recordGate: does not clobber an existing answer with undefined", () => {
  const meta = recordGate({ fanout: "yes" }, "fanout", undefined);
  equal(meta.fanout, "yes");
});

test("GATE_KEYS: exactly the three questions the skill poses", () => {
  deepEqual([...GATE_KEYS].sort(), ["batching", "fanout", "mix"]);
});

// ── Inline-cost arithmetic ───────────────────────────────────────────────────
// The skill states the formula (total lines x ~10) and that `none` on a cold
// corpus is itself the honest answer. The driver must never invent a number.

test("inlineEstimate: lines x 10", () => {
  equal(inlineEstimate({ totalLines: 5000 }).tokens, 50000);
});

test("inlineEstimate: renders in k for readability", () => {
  match(inlineEstimate({ totalLines: 5000 }).text, /~50k tokens/);
});

test("inlineEstimate: no inline path is 'not comparable', never a number", () => {
  const e = inlineEstimate({ totalLines: 0, comparable: false });
  equal(e.tokens, null);
  match(e.text, /not comparable/);
});

test("inlineEstimate: a cold corpus is 'none', never 0", () => {
  const e = inlineEstimate({ totalLines: 0 });
  equal(e.tokens, null);
  match(e.text, /none/);
  ok(!/~0k/.test(e.text), "must not render a fabricated zero");
});

// ── Liveness: one check, and a cache replay is not success ───────────────────
// A session skipped this check and announced "Round 3 is running" when nothing
// was: a bare re-run of a complete manifest replays cache, 16/16 [skipped].

test("livenessVerdict: at least one running leaf is live", () => {
  const v = livenessVerdict({ states: ["running", "pending", "ok"] });
  equal(v.live, true);
});

test("livenessVerdict: all-skipped is a CACHE REPLAY, not a live run ★", () => {
  const v = livenessVerdict({ states: ["skipped", "skipped"], skipped: 2, total: 2 });
  equal(v.live, false);
  equal(v.cacheReplay, true);
  match(v.reason, /cache/i);
});

test("livenessVerdict: all-ok with nothing running is not live", () => {
  const v = livenessVerdict({ states: ["ok", "ok"] });
  equal(v.live, false);
});

test("livenessVerdict: an empty roster is not live", () => {
  const v = livenessVerdict({ states: [] });
  equal(v.live, false);
});

// ── Failure routing: a table over three booleans ─────────────────────────────
// The skill states commits-since-last-attempt is the discriminator, NOT attempt
// count alone: auto-resume converges for a leaf that made progress and loops for
// one that did not.

test("routeFailure: a plain timeout re-runs without asking", () => {
  const r = routeFailure({ timedOut: true, erroredOnce: false, committedSince: false, attempts: 1 });
  equal(r.action, "rerun");
  equal(r.ask, false);
});

test("routeFailure: an error gets ONE automatic retry, then asks", () => {
  equal(routeFailure({ timedOut: false, erroredOnce: true, attempts: 1 }).action, "retry");
  equal(routeFailure({ timedOut: false, erroredOnce: true, attempts: 2 }).ask, true);
});

test("routeFailure: a second timeout with nothing committed stops and asks ★", () => {
  const r = routeFailure({ timedOut: true, erroredOnce: false, committedSince: false, attempts: 2 });
  equal(r.ask, true);
  match(r.reason, /commit/i);
});

test("routeFailure: a second timeout that DID commit keeps going", () => {
  const r = routeFailure({ timedOut: true, erroredOnce: false, committedSince: true, attempts: 2 });
  equal(r.action, "rerun");
  equal(r.ask, false);
});

test("routeFailure: quota offers the recast-to-cloud option", () => {
  const r = routeFailure({ quota: true, attempts: 1 });
  ok(r.options.some((o) => /recast/i.test(o)));
});

// ── The results dir is copied, never reconstructed ───────────────────────────
// A session guessed a path from the manifest stem and published `p5-review-2`,
// a directory that has never existed.

test("captureResultsDir: reads the engine's printed line", () => {
  const out = "some preamble\nresultsDir: C:/runs/p5-review-1\nwatch: node x status C:/runs/p5-review-1\n";
  equal(captureResultsDir(out), "C:/runs/p5-review-1");
});

test("captureResultsDir: absent line yields null, never a guess ★", () => {
  equal(captureResultsDir("no such line here"), null);
});

test("captureResultsDir: takes the FIRST printed dir, not a later mention", () => {
  const out = "resultsDir: C:/runs/a-1\nchatter C:/runs/a-2\n";
  equal(captureResultsDir(out), "C:/runs/a-1");
});
