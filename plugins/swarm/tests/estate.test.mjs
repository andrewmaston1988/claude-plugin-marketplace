import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildSnapshot, filterRuns } from "../src/serve/estate.mjs";
import { readRun } from "../src/runlog.mjs";
import { NOW, buildFixture } from "./fixtures/run-fixture.mjs";
import { touchHeartbeat, heartbeatPath } from "../src/results.mjs";

const HEARTBEAT_MS = 15_000;
const QUIET_WARN_MS = 60_000;
const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/estate-golden.json", import.meta.url)), "utf8"));

function seedFinished(home, project, name, ageHours) {
  const d = join(home, "runs", project, name);
  buildFixture(d);
  writeFileSync(join(d, "summary.json"), JSON.stringify({ started: "2026-09-05T00:00:00Z", finished: "2026-09-05T00:30:00Z", tasks: [] }), "utf8");
  const t = (NOW - ageHours * 3600_000) / 1000;
  utimesSync(join(d, "run.log"), t, t);
  return d;
}

function seedActive(home, project, name) {
  const d = join(home, "runs", project, name);
  buildFixture(d);
  const t = (NOW - 5000) / 1000;
  utimesSync(join(d, "run.log"), t, t);
  touchHeartbeat(d, new Date(NOW - 5000).toISOString(), process.pid);
  utimesSync(heartbeatPath(d), t, t);
  return d;
}

test("E1: buildSnapshot reads every run once, then none when nothing changed, same version", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-estate-e1-"));
  try {
    for (let i = 0; i < 28; i++) seedFinished(home, "C--code-a", `fin-${i}`, i + 1);
    seedActive(home, "C--code-a", "live-1");
    seedActive(home, "C--code-b", "live-2");
    let reads = 0;
    const _readRun = (dir, opts) => { reads++; return readRun(dir, opts); };
    const cache = new Map();
    const s1 = buildSnapshot(home, cache, { now: NOW, heartbeatMs: HEARTBEAT_MS, quietWarnMs: QUIET_WARN_MS, _readRun });
    assert.equal(reads, 30, "one read per run on the first build");
    reads = 0;
    const s2 = buildSnapshot(home, cache, { now: NOW, heartbeatMs: HEARTBEAT_MS, quietWarnMs: QUIET_WARN_MS, _readRun });
    assert.equal(reads, 0, "nothing changed: zero reads on the second build");
    assert.equal(s2.version, s1.version, "same rows, same version");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("E2: appending to one active run's run.log re-reads only that run, and moves the version", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-estate-e2-"));
  try {
    seedFinished(home, "C--code-a", "fin-0", 1);
    const live = seedActive(home, "C--code-a", "live-1");
    let reads = 0;
    const _readRun = (dir, opts) => { reads++; return readRun(dir, opts); };
    const cache = new Map();
    const s1 = buildSnapshot(home, cache, { now: NOW, heartbeatMs: HEARTBEAT_MS, quietWarnMs: QUIET_WARN_MS, _readRun });
    reads = 0;
    writeFileSync(join(live, "run.log"), readFileSync(join(live, "run.log"), "utf8") + '\n{"ts":"2026-09-05T01:09:59Z","id":"find-b","state":"ok","durationMs":1000}', "utf8");
    const t = NOW / 1000;
    utimesSync(join(live, "run.log"), t, t);
    const s2 = buildSnapshot(home, cache, { now: NOW, heartbeatMs: HEARTBEAT_MS, quietWarnMs: QUIET_WARN_MS, _readRun });
    assert.equal(reads, 1, "only the changed run is re-read");
    assert.notEqual(s2.version, s1.version, "the version moves");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("E3: filterRuns over the snapshot matches the pre-change handler's captured output", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-estate-e3-"));
  try {
    for (let i = 0; i < 12; i++) seedFinished(home, "C--code-alpha", `fin-${i}`, i + 1);
    for (let i = 0; i < 3; i++) seedFinished(home, "C--code-.worktrees-alpha-branch-a", `wt-a-${i}`, 20 + i);
    for (let i = 0; i < 9; i++) seedFinished(home, "C--code-beta", `fin-${i}`, i + 1);
    seedActive(home, "C--code-alpha", "live-1");
    seedActive(home, "C--code-gamma", "live-2");

    const cache = new Map();
    const snapshot = buildSnapshot(home, cache, { now: NOW, heartbeatMs: HEARTBEAT_MS, quietWarnMs: QUIET_WARN_MS });

    const plain = filterRuns(snapshot.rows, { finishedPerProject: 3, expanded: new Set() });
    assert.deepEqual(plain.rows, GOLDEN.plain.runs, "unexpanded rows match the captured handler output");
    assert.deepEqual(plain.finishedTotals, GOLDEN.plain.finishedTotals);

    const expanded = filterRuns(snapshot.rows, { finishedPerProject: 3, expanded: new Set(["C--code-alpha"]) });
    assert.deepEqual(expanded.rows, GOLDEN.expanded.runs, "expand=C--code-alpha matches the captured handler output");
    assert.deepEqual(expanded.finishedTotals, GOLDEN.expanded.finishedTotals);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
