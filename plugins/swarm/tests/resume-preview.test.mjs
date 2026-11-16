// What validate promises a resume will re-run. Every row builds a real run dir
// and reads the preview line; liveness is a call-time fake except where the row
// is about the real heartbeat.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resumePreview } from "../src/resume-preview.mjs";
import { initResultsDir, writeResult } from "../src/results.mjs";
import { taskKey } from "../src/task-key.mjs";

const LIVE = () => ({ finishedMs: null, stoppedMs: null, abortedMs: null });
const FINISHED = () => ({ finishedMs: Date.parse("2026-11-15T10:00:00Z"), stoppedMs: null, abortedMs: null });

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "swarm-preview-"));
}

function runDir() {
  return initResultsDir(tmpDir());
}

function task(id, over = {}) {
  return {
    id, prompt: `do ${id}`, model: "claude-haiku-4-5-20251001", provider: "claude",
    allowedTools: "Read,Grep,Glob", cwd: tmpdir(), timeoutMs: 5000, after: [], ...over,
  };
}

const stored = (dir, t) => writeResult(dir, t.id, { id: t.id, ok: true, key: taskKey(t) });
const preview = (dir, tasks, opts = { liveness: FINISHED }) => resumePreview({ resultsDir: dir, tasks }, opts);

test("row 9: no earlier run means no warning", () => {
  const bare = tmpDir();
  try {
    deepEqual(preview(bare, [task("a")]), [], "a dir with no results/ has nothing to report");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
  // Initialised but never finished a leaf — not an earlier run.
  const fresh = runDir();
  try {
    writeFileSync(join(fresh, "results", "a.ask.log"), "question\n");
    deepEqual(preview(fresh, [task("a")]), [], "a fresh manifest has nothing to re-run");
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
});

test("row 10: changed definition, new task, and a keyless legacy result", () => {
  const dir = runDir();
  try {
    writeResult(dir, "changed", { id: "changed", ok: true, key: "0000000000000000" });
    writeResult(dir, "legacy", { id: "legacy", ok: true });
    const [line] = preview(dir, [task("changed"), task("legacy"), task("added")]);
    ok(line.includes("changed (definition changed)"), line);
    ok(line.includes("added (new)"), line);
    ok(!line.includes("legacy"), `a pre-key ok result is reused, as cacheHit does: ${line}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("row 11: re-execution reaches dependents, and expanded leaves are deferred", () => {
  const dir = runDir();
  try {
    const a = task("a");
    const b = task("b", { after: ["a"] });
    const c = task("c", { after: ["b"] });
    const unrelated = task("unrelated");
    const fan = task("fan", { forEach: { from: "a", path: "", maxItems: 5 } });
    const node = task("node", { childPlan: { tasks: [task("inner")] } });
    writeResult(dir, "a", { id: "a", ok: true, key: "0000000000000000" });
    writeResult(dir, "fan", { id: "fan", ok: true, key: "1111111111111111" });
    writeResult(dir, "node", { id: "node", ok: true, key: "2222222222222222" });
    for (const t of [b, c, unrelated]) stored(dir, t);
    const [line] = preview(dir, [a, b, c, unrelated, fan, node]);
    ok(line.includes("a (definition changed)"), line);
    ok(line.includes("b (depends on a)"), `a direct dependent re-runs: ${line}`);
    ok(line.includes("c (depends on b)"), `transitively, through its own dependency: ${line}`);
    ok(!line.includes("unrelated"), `an independent task is untouched: ${line}`);
    ok(line.includes("clones of fan are checked when they expand"), line);
    ok(line.includes("child leaves of node are checked when they expand"), line);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("row 12: liveness, unreadable results, and no write to run.log", () => {
  const dir = runDir();
  try {
    writeResult(dir, "changed", { id: "changed", ok: true, key: "0000000000000000" });
    const logLine = '{"ts":"2026-11-15T10:00:00.000Z","event":"run-start","tasks":[]}\n';
    writeFileSync(join(dir, "run.log"), logLine);
    ok(preview(dir, [task("changed")], { liveness: LIVE })[0].includes("(live engine)"));
    ok(preview(dir, [task("changed")], { liveness: FINISHED })[0].includes("(finished)"));
    equal(readFileSync(join(dir, "run.log"), "utf8"), logLine, "the preview must not touch run.log");
    ok(!readFileSync(join(dir, "run.log"), "utf8").includes("cache-miss"));

    // A live engine mid-write leaves unparseable JSON; that is not a new task.
    writeFileSync(join(dir, "results", "torn.json"), "{ not json");
    const [line] = preview(dir, [task("changed"), task("torn")]);
    ok(line.includes("torn (unreadable)"), line);
    ok(!line.includes("torn (new)"), line);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // No run.log before the call: none after it either.
  const clean = runDir();
  try {
    writeResult(clean, "changed", { id: "changed", ok: true, key: "0000000000000000" });
    preview(clean, [task("changed")]);
    ok(!existsSync(join(clean, "run.log")), "validate writes no cache-miss line into a run dir");
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }
});

test("row 12: the default liveness is the run's real heartbeat", () => {
  const dir = runDir();
  try {
    writeResult(dir, "changed", { id: "changed", ok: true, key: "0000000000000000" });
    writeFileSync(join(dir, "run.log"), '{"ts":"2026-11-15T10:00:00.000Z","event":"run-start","tasks":[]}\n');
    const beat = join(dir, "heartbeat");
    writeFileSync(beat, new Date().toISOString() + " 1234\n");
    ok(resumePreview({ resultsDir: dir, tasks: [task("changed")] })[0].includes("(live engine)"));
    const stale = new Date(Date.now() - 600_000);
    utimesSync(beat, stale, stale);
    ok(resumePreview({ resultsDir: dir, tasks: [task("changed")] })[0].includes("(finished)"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
