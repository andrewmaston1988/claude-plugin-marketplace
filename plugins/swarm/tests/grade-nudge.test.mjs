// Grade-nudge rows 3, 3b, 4, 4c, 6, 7, 9 (reader half), 11 of
// swarm-grading-nudge-test-plan.md — against the exported decision function
// with injected state, plus ungradedRuns over fixture run trees. The plugin
// spawns no hook binary in tests; decideGradeNudge is the seam.
import { test } from "node:test";
import { equal, deepEqual, ok, match } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { decideGradeNudge, ungradedRuns, lastRunStart } from "../src/grade-nudge.mjs";
import { gradedRunKeys } from "../src/scores.mjs";
import { waiverPath } from "../src/results.mjs";

const GRADING_ON = { grading: { enabled: true } };

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-gn-"));
}

// A run dir under <home>/runs/<enc>/<name>: run.log built from the given
// run-start stamps (a resume appends a second one) plus an optional broken
// tail, and a results/ holding one leaf per id. The wrong-answer fixtures are
// built with the same helper on purpose — a walker that lists everything, or
// a decision that attributes unstamped runs, must trip them.
// `live` picks the liveness fixture ungradedRuns' D4 predicate reads:
// "finished" (default — a summary.json with a finished timestamp, so every
// pre-D4 test here keeps meaning "done" without knowing liveness exists),
// "in-flight" (a fresh heartbeat, no summary), or "aborted" (a heartbeat
// backdated well past runLiveness' default staleness window, no summary).
function runDir(home, { enc = "C--code-x", name, starts, tail = [], results = ["a"], noResults = false, live = "finished" }) {
  const dir = join(home, "runs", enc, name);
  mkdirSync(dir, { recursive: true });
  const lines = starts.map((s) => JSON.stringify({ ts: "2026-09-10T00:00:00Z", event: "run-start", pid: 1, tasks: [{ id: "a", model: "m" }], ...s }));
  writeFileSync(join(dir, "run.log"), [...lines, ...tail].join("\n") + "\n");
  if (!noResults) {
    mkdirSync(join(dir, "results"), { recursive: true });
    for (const id of results) writeFileSync(join(dir, "results", `${id}.json`), JSON.stringify({ id, model: "m", ok: true }));
  }
  if (live === "finished") {
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ started: "2026-09-10T00:00:00Z", finished: "2026-09-10T00:05:00Z" }));
  } else if (live === "in-flight") {
    writeFileSync(join(dir, "heartbeat"), `${new Date().toISOString()} 1\n`);
  } else if (live === "aborted") {
    const hb = join(dir, "heartbeat");
    writeFileSync(hb, "2020-01-01T00:00:00.000Z 1\n");
    const stale = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(hb, stale, stale);
  }
  return dir;
}

function decide({ runs, graded = new Set(), sessionId = "me" }) {
  return decideGradeNudge({ config: GRADING_ON, runs, graded, sessionId });
}

test("row 3 / B4 / B5: only runs this session dispatched are listed — another session's and unstamped are not", () => {
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

test("B2: a finished ungraded run blocks the first stop and the second — decideGradeNudge keeps no once-gate of its own", () => {
  const home = tmp();
  try {
    runDir(home, { name: "once-1", starts: [{ launcher: "me" }] });
    const runs = ungradedRuns({ home });
    ok(decideGradeNudge({ config: GRADING_ON, runs, graded: new Set(), sessionId: "me" }).block, "the first stop blocks");
    ok(
      decideGradeNudge({ config: GRADING_ON, runs, graded: new Set(), sessionId: "me", seen: { me: Date.now() } }).block,
      "the second stop blocks too — an old-shaped seen marker, if one is even passed in, must not silence it"
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("row 7 / B6: grading.enabled false — silent regardless of how many ungraded runs exist", () => {
  const home = tmp();
  try {
    runDir(home, { name: "a-1", starts: [{ launcher: "me" }] });
    runDir(home, { name: "b-1", starts: [{ launcher: "me" }] });
    const runs = ungradedRuns({ home });
    equal(decideGradeNudge({ config: { grading: { enabled: false } }, runs, graded: new Set(), sessionId: "me" }).block, false);
    equal(decideGradeNudge({ config: {}, runs, graded: new Set(), sessionId: "me" }).block, false, "the key absent entirely is the same as off");
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

test("B1: an in-flight run (fresh heartbeat, no summary) never blocks a stop", () => {
  const home = tmp();
  try {
    runDir(home, { name: "inflight-1", starts: [{ launcher: "me" }], live: "in-flight" });
    const runs = ungradedRuns({ home });
    deepEqual(runs, [], "an in-flight run must not be listed");
    equal(decide({ runs }).block, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("B7: an aborted run (stale heartbeat, no summary) never blocks — it awaits its resumer", () => {
  const home = tmp();
  try {
    runDir(home, { name: "aborted-1", starts: [{ launcher: "me" }], live: "aborted" });
    const runs = ungradedRuns({ home });
    deepEqual(runs, [], "an aborted run must not be listed");
    equal(decide({ runs }).block, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("B3: grading a run, or waiving it, clears only that run", () => {
  const home = tmp();
  try {
    const gradedLater = runDir(home, { name: "grade-me-1", starts: [{ launcher: "me" }] });
    const waivedLater = runDir(home, { name: "waive-me-1", starts: [{ launcher: "me" }] });
    const untouched = runDir(home, { name: "leave-me-1", starts: [{ launcher: "me" }] });

    const graded = gradedRunKeys([{ resultsDir: gradedLater, leaf: "a", outcome: "completed" }]);
    writeFileSync(waiverPath(waivedLater), JSON.stringify({ waivedAt: new Date().toISOString(), reason: "smoke" }));

    const runs = ungradedRuns({ home, graded });
    const dirs = runs.map((r) => r.dir);
    ok(dirs.includes(untouched), "the untouched run is still listed");
    ok(!dirs.includes(gradedLater), "the graded run is cleared");
    ok(!dirs.includes(waivedLater), "the waived run is cleared");

    const d = decide({ runs, graded });
    ok(d.reason.includes(untouched));
    ok(!d.reason.includes(gradedLater));
    ok(!d.reason.includes(waivedLater));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("B8: a waived run is skipped before its run.log is read", () => {
  const home = tmp();
  try {
    const waived = runDir(home, { name: "waived-1", starts: [{ launcher: "me" }] });
    writeFileSync(waiverPath(waived), JSON.stringify({ waivedAt: new Date().toISOString(), reason: "smoke" }));
    runDir(home, { name: "ungraded-1", starts: [{ launcher: "me" }] });

    const read = [];
    const runs = ungradedRuns({ home, _readFile: (p, enc) => { read.push(p); return readFileSync(p, enc); } });

    deepEqual(runs.map((r) => basename(r.dir)), ["ungraded-1"]);
    ok(!read.some((p) => p.includes("waived-1")), "the waived run's run.log must never be read");
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
test("the walk never reads the run.log of a run it can skip on a cheap predicate", () => {
  const home = tmp();
  try {
    // Every enabled stop pays for this whole walk, and run.log is the expensive
    // read — 45.6MB across the real estate, largest 2.2MB. Output alone cannot
    // prove the ordering: reading a log and then skipping the run leaves exactly
    // the same result as never reading it. So count the reads.
    const graded = new Set();
    for (const name of ["graded-1", "graded-2"]) graded.add(runDir(home, { name, starts: [{ launcher: "me" }] }).replaceAll("\\", "/").toLowerCase());
    runDir(home, { name: "nothing-to-grade-1", starts: [{ launcher: "me" }], noResults: true });
    runDir(home, { name: "ungraded-1", starts: [{ launcher: "me" }] });

    const read = [];
    const runs = ungradedRuns({ home, graded, _readFile: (p, enc) => { read.push(p); return readFileSync(p, enc); } });

    deepEqual(runs.map((r) => basename(r.dir)), ["ungraded-1"]);
    equal(read.length, 1, "only the one run that survives the cheap predicates has its log read");
    ok(read[0].includes("ungraded-1"), `the single read was ${read[0]}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
