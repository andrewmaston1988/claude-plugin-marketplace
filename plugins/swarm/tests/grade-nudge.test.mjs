// Grade-nudge rows 3, 3b, 4, 4c, 6, 7, 9 (reader half), 11 of
// swarm-grading-nudge-test-plan.md — against the exported decision function
// with injected state, plus ungradedRuns over fixture run trees. The plugin
// spawns no hook binary in tests; decideGradeNudge is the seam.
import { test } from "node:test";
import { equal, deepEqual, ok, match } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decideGradeNudge, ungradedRuns, lastRunStart } from "../src/grade-nudge.mjs";
import { gradedRunKeys } from "../src/scores.mjs";

const GRADING_ON = { grading: { enabled: true } };

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-gn-"));
}

// A run dir under <home>/runs/<enc>/<name>: run.log built from the given
// run-start stamps (a resume appends a second one) plus an optional broken
// tail, and a results/ holding one leaf per id. The wrong-answer fixtures are
// built with the same helper on purpose — a walker that lists everything, or
// a decision that attributes unstamped runs, must trip them.
function runDir(home, { enc = "C--code-x", name, starts, tail = [], results = ["a"], noResults = false }) {
  const dir = join(home, "runs", enc, name);
  mkdirSync(dir, { recursive: true });
  const lines = starts.map((s) => JSON.stringify({ ts: "2026-09-10T00:00:00Z", event: "run-start", pid: 1, tasks: [{ id: "a", model: "m" }], ...s }));
  writeFileSync(join(dir, "run.log"), [...lines, ...tail].join("\n") + "\n");
  if (!noResults) {
    mkdirSync(join(dir, "results"), { recursive: true });
    for (const id of results) writeFileSync(join(dir, "results", `${id}.json`), JSON.stringify({ id, model: "m", ok: true }));
  }
  return dir;
}

function decide({ runs, graded = new Set(), sessionId = "me", seen = {} }) {
  return decideGradeNudge({ config: GRADING_ON, runs, graded, sessionId, seen });
}

test("row 3: only runs this session dispatched are listed — another session's and unstamped are not", () => {
  const home = tmp();
  try {
    const mine = runDir(home, { name: "mine-1", starts: [{ launcher: "me" }] });
    runDir(home, { name: "theirs-1", starts: [{ launcher: "someone-else" }] }); // the other-session fixture
    runDir(home, { name: "orphan-1", starts: [{}] });                          // unstamped — belongs to nobody
    const d = decide({ runs: ungradedRuns({ home }) });
    ok(d.block, "this session's ungraded run must block");
    ok(d.reason.includes(mine), `the reason must name ${mine}`);
    ok(!d.reason.includes("theirs-1"), "another session's run must not be listed");
    ok(!d.reason.includes("orphan-1"), "an unstamped run must not be listed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("row 3b: a run dir with a run.log but no results is not listed — nothing to grade", () => {
  const home = tmp();
  try {
    runDir(home, { name: "hollow-1", starts: [{ launcher: "me" }], noResults: true });
    runDir(home, { name: "leafless-1", starts: [{ launcher: "me" }], results: [] }); // results/ exists, but...
    writeFileSync(join(home, "runs", "C--code-x", "leafless-1", "results", "a.log"), "a transcript, not a result");
    const runs = ungradedRuns({ home });
    deepEqual(runs.map((r) => r.launcher), [], "neither the dir without results/ nor the one holding only a .log may appear");
    equal(decide({ runs }).block, false, "nothing to grade means no block");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("row 4: two stamped runs, one with store rows — only the ungraded one is listed, with its grade --init", () => {
  const home = tmp();
  try {
    const gradedDir = runDir(home, { name: "graded-1", starts: [{ launcher: "me" }] });
    const fresh = runDir(home, { name: "fresh-1", starts: [{ launcher: "me" }] });
    const graded = gradedRunKeys([{ resultsDir: gradedDir, leaf: "a", outcome: "completed" }]);
    // The walk is given no graded set on purpose — both runs reach the decision,
    // which must drop the graded one itself.
    const d = decide({ runs: ungradedRuns({ home }), graded });
    ok(d.block);
    match(d.reason, /grade --init/);
    ok(d.reason.includes(fresh), "the ungraded run is named");
    ok(!d.reason.includes("graded-1"), "a run with store rows must not be listed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("row 4c: an all-failed run graded with outcome:failed and no grades counts as graded", () => {
  const home = tmp();
  try {
    const dead = runDir(home, { name: "dead-1", starts: [{ launcher: "me" }] });
    const graded = gradedRunKeys([{ resultsDir: dead, leaf: "a", outcome: "failed", note: "every leaf died" }]); // no grades object
    const d = decide({ runs: ungradedRuns({ home, graded }), graded });
    equal(d.block, false, "a failed-outcome row is the correct output for a dead leaf — the run is graded");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("row 6: blocks once per session — a second stop is silent, a different session blocks again", () => {
  const home = tmp();
  try {
    runDir(home, { name: "once-1", starts: [{ launcher: "me" }] });
    runDir(home, { name: "other-1", starts: [{ launcher: "other" }] });
    const runs = ungradedRuns({ home });
    ok(decide({ runs, seen: {} }).block, "the first stop blocks");
    equal(decide({ runs, seen: { me: Date.now() } }).block, false, "the marker makes the second stop silent");
    ok(decide({ runs, sessionId: "other", seen: { me: Date.now() } }).block, "another session gets its own one block");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("row 7: grading.enabled false — silent regardless of how many ungraded runs exist", () => {
  const home = tmp();
  try {
    runDir(home, { name: "a-1", starts: [{ launcher: "me" }] });
    runDir(home, { name: "b-1", starts: [{ launcher: "me" }] });
    const runs = ungradedRuns({ home });
    equal(decideGradeNudge({ config: { grading: { enabled: false } }, runs, graded: new Set(), sessionId: "me", seen: {} }).block, false);
    equal(decideGradeNudge({ config: {}, runs, graded: new Set(), sessionId: "me", seen: {} }).block, false, "the key absent entirely is the same as off");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("row 9: a resumed run belongs to its resumer — the LAST run-start wins", () => {
  const home = tmp();
  try {
    const resumed = runDir(home, { name: "resumed-1", starts: [{ launcher: "abc" }, { launcher: "xyz" }] });
    const runs = ungradedRuns({ home });
    equal(runs.find((r) => r.dir === resumed).launcher, "xyz");
    equal(decide({ runs, sessionId: "abc" }).block, false, "the original session is no longer asked to grade a run it resumed away");
    ok(decide({ runs, sessionId: "xyz" }).block, "the resumer is");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("row 9, other half: a resume with no session id re-stamps the run to nobody", () => {
  const home = tmp();
  try {
    runDir(home, { name: "abandoned-1", starts: [{ launcher: "abc" }, {}] });
    const runs = ungradedRuns({ home });
    equal(runs[0].launcher, null);
    equal(decide({ runs, sessionId: "abc" }).block, false, "an unstamped re-start leaves the run owned by nobody");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("row 11: a broken tail after the run-start line never breaks the decision — torn lines are skipped", () => {
  const home = tmp();
  try {
    // The torn tail includes a half-written run-start: it carries the marker the
    // reader filters on but does not parse. Only the per-line try/catch keeps it
    // from throwing — a plain tail of non-run-start text is skipped before the
    // filter and guards nothing.
    runDir(home, { name: "torn-1", starts: [{ launcher: "me" }], tail: ['{"event":"run-start","ts":"torn', "{not json at all"] });
    const d = decide({ runs: ungradedRuns({ home }) });
    ok(d.block, "the run-start still resolves and the run is listed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("lastRunStart: the last run-start wins over earlier ones and over torn lines", () => {
  const log = [
    JSON.stringify({ ts: "1", event: "run-start", launcher: "abc" }),
    "{torn mid-run write",
    JSON.stringify({ ts: "2", event: "run-start", launcher: "xyz" }),
    '{"event":"run-start","ts":"also torn mid-write',
  ].join("\n");
  equal(lastRunStart(log).launcher, "xyz", "the torn run-start after it is skipped, the valid one before it is the last");
  equal(lastRunStart(""), null);
  equal(lastRunStart('{"event":"run-start","ts":"torn'), null, "a log whose only run-start is torn has no owner");
});