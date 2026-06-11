// Shared dashboard view-model — the keying/derivation contract both the TUI
// and web renderers consume. These tests exist to make the progress-lookup
// regression class (web showing 0/0 while TUI shows N/M) structurally
// impossible: the lookup lives in ONE module and the contract is pinned here.
import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";

import { agentsViewModel } from "../src/dashboard/shared/view-model/agents.mjs";
import { pipelineViewModel, sortRows, createTransitionTracker } from "../src/dashboard/shared/view-model/pipeline.mjs";
import { orchViewModel } from "../src/dashboard/shared/view-model/orch.mjs";
import { sessionState, sessionGlyph, PALETTE, STAGE_ORDER } from "../src/dashboard/shared/view-model/glyph.mjs";
import { fmtAge } from "../src/dashboard/shared/view-model/util.mjs";

const NOW = Date.parse("2026-06-11T12:00:00Z");

function session(overrides = {}) {
  return {
    feature: "my-feature",
    session_type: "dev",
    correlation_id: "my-feature-20260611T100000Z",
    session_file: "C:\\proj\\sessions\\dev-2026-06-11-my-feature.md",
    spawn_time: new Date(NOW - 60_000).toISOString(),
    is_active: 1,
    pid: 1,
    ...overrides,
  };
}

// ── agents: progress keying contract ─────────────────────────────────────────

test("agents view-model keys progress by correlation_id, never session_file basename", () => {
  const s = session();
  const progress = {
    // Correct key — must be found.
    [s.correlation_id]: { step: 3, total: 6, done: 3, inprog: 0, todo: 3 },
    // Decoy under the session-file basename — must NOT be picked up.
    "dev-2026-06-11-my-feature": { step: 9, total: 9, done: 9, inprog: 0, todo: 0 },
  };
  const [m] = agentsViewModel([s], progress, { now: NOW });
  equal(m.progress.step, 3);
  equal(m.progress.total, 6);
});

test("agents view-model: missing progress entry renders 0/0, not a crash", () => {
  const [m] = agentsViewModel([session()], {}, { now: NOW });
  deepEqual(m.progress, { step: 0, total: 0, done: 0, inprog: 0, todo: 0 });
});

test("agents view-model excludes inactive sessions", () => {
  const models = agentsViewModel([session({ is_active: 0 })], {}, { now: NOW });
  equal(models.length, 0);
});

// ── glyph: session state ladder ──────────────────────────────────────────────

test("sessionState ladder: dead > stalled > working > waiting", () => {
  const prog = { step: 1, total: 3, done: 1, inprog: 1, todo: 1 };
  // pid probe says dead — wins over everything.
  equal(sessionState(session({ pid: 999 }), prog, { now: NOW, pidAlive: () => false }), "dead");
  // in-progress and spawned 31 min ago — stalled.
  const old = session({ spawn_time: new Date(NOW - 31 * 60_000).toISOString() });
  equal(sessionState(old, prog, { now: NOW }), "stalled");
  // in-progress, fresh — working.
  equal(sessionState(session(), prog, { now: NOW }), "working");
  // alive but nothing in progress — waiting.
  equal(sessionState(session(), { step: 0, total: 2, done: 0, inprog: 0, todo: 2 }, { now: NOW }), "waiting");
});

test("sessionState: mock pids (<= 4) are never probed", () => {
  const prog = { step: 0, total: 1, done: 0, inprog: 1, todo: 0 };
  const state = sessionState(session({ pid: 3 }), prog, { now: NOW, pidAlive: () => false });
  equal(state, "working");
});

test("sessionGlyph: working spins in stage color; dead is a static red cross", () => {
  const working = sessionGlyph("working", "#7dcfff");
  equal(working.spinning, true);
  equal(working.glyphColor, "#7dcfff");
  const dead = sessionGlyph("dead", "#7dcfff");
  equal(dead.spinning, false);
  equal(dead.char, "✗");
  equal(dead.glyphColor, PALETTE.red);
});

// ── pipeline: sort, counts, row semantics ────────────────────────────────────

test("sortRows orders by STAGE_ORDER with unknown stages last", () => {
  const rows = [{ stage: "done" }, { stage: "weird" }, { stage: "merge" }, { stage: "dev" }];
  const sorted = sortRows(rows).map(r => r.stage);
  deepEqual(sorted, ["merge", "dev", "done", "weird"]);
  ok(STAGE_ORDER.includes("merge"));
});

test("pipeline view-model: counts and done-filtering", () => {
  const rows = [
    { feature: "a", stage: "dev" },
    { feature: "b", stage: "queued", notes_extra: "type=review" },
    { feature: "c", stage: "done" },
  ];
  const vm = pipelineViewModel(rows, { now: NOW });
  equal(vm.counts.queued, 1);
  equal(vm.counts.done, 1);
  equal(vm.counts.active, 1);
  deepEqual(vm.rows.map(r => r.feature), ["a", "b"]); // done filtered, sorted
  const vmAll = pipelineViewModel(rows, { showAll: true, now: NOW });
  equal(vmAll.rows.length, 3);
});

test("pipeline view-model: queued rows substitute the queued-type label", () => {
  const vm = pipelineViewModel([{ feature: "b", stage: "queued", notes_extra: "type=review" }], { now: NOW });
  equal(vm.rows[0].stageLabel, "review");
  equal(vm.rows[0].icon, "queue");
});

test("pipeline view-model: blocked manual row is red, icon=blocked, notes red", () => {
  const vm = pipelineViewModel(
    [{ feature: "x", stage: "manual", notes_extra: "blocked: session slug mismatch" }],
    { now: NOW },
  );
  const r = vm.rows[0];
  equal(r.blocked, true);
  equal(r.icon, "blocked");
  equal(r.featureColor, PALETTE.red);
  equal(r.notesColor, PALETTE.red);
});

test("pipeline view-model: parked-review-budget row renders as bold red blocked", () => {
  const vm = pipelineViewModel(
    [{ feature: "x", stage: "manual", notes_extra: "type=dev [parked-review-budget-exhausted 2026-06-11]" }],
    { now: NOW },
  );
  const r = vm.rows[0];
  equal(r.stageLabel, "blocked");
  equal(r.stageBold, true);
  equal(r.icon, "blocked");
});

test("pipeline view-model: live session wins icon over qa-fail; blocked wins over live", () => {
  const sessions = [session({ feature: "x" })];
  const live = pipelineViewModel([{ feature: "x", stage: "test", qa_pass: 0 }], { sessions, now: NOW });
  equal(live.rows[0].icon, "spin");
  const blocked = pipelineViewModel(
    [{ feature: "x", stage: "manual", notes_extra: "blocked: y" }],
    { sessions, now: NOW },
  );
  equal(blocked.rows[0].icon, "blocked");
});

test("pipeline view-model: type= metadata notes are suppressed", () => {
  const vm = pipelineViewModel([{ feature: "b", stage: "queued", notes_extra: "type=dev" }], { now: NOW });
  equal(vm.rows[0].notes, "");
});

test("transition tracker: shimmerSecs reports the stage change and expires", () => {
  const tracker = createTransitionTracker();
  tracker.track([{ feature: "f", stage: "dev" }], NOW);
  // The transition is recorded by this same call's track(), so elapsed is 0 —
  // consumers must null-check shimmerSecs, not truthiness-check it.
  let vm = pipelineViewModel([{ feature: "f", stage: "review" }], { tracker, now: NOW + 1000 });
  equal(vm.rows[0].shimmerSecs, 0);
  vm = pipelineViewModel([{ feature: "f", stage: "review" }], { tracker, now: NOW + 120_000 });
  equal(vm.rows[0].shimmerSecs, null);
});

// ── orch + util ──────────────────────────────────────────────────────────────

test("orch view-model: absent renders off with dashes", () => {
  const vm = orchViewModel({ alive: false, status: "absent" }, NOW);
  equal(vm.off, true);
  equal(vm.pid, "—");
  equal(vm.polled, "—");
});

test("orch view-model: alive renders on/green with ages", () => {
  const vm = orchViewModel(
    { alive: true, pid: 123, last_poll: new Date(NOW - 5000).toISOString(), started_at: new Date(NOW - 3600_000).toISOString() },
    NOW,
  );
  equal(vm.status, "on");
  equal(vm.statusColor, PALETTE.green);
  equal(vm.polled, "5s");
  equal(vm.uptime, "1h");
});

test("fmtAge buckets", () => {
  equal(fmtAge(new Date(NOW - 30_000).toISOString(), NOW), "30s");
  equal(fmtAge(new Date(NOW - 5 * 60_000).toISOString(), NOW), "5m");
  equal(fmtAge(new Date(NOW - 5 * 3600_000).toISOString(), NOW), "5h");
  equal(fmtAge(new Date(NOW - 3 * 86400_000).toISOString(), NOW), "3d");
  equal(fmtAge(null, NOW), "—");
});
