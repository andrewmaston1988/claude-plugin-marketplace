import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "./helpers/cli.mjs";
import { EXIT_CLEAN, EXIT_DEAD, EXIT_FAILED, settledCode, waitForRun } from "../src/wait.mjs";

const NOW = Date.parse("2026-09-05T01:10:00Z");

// A minimal readRun shape: only the fields the wait loop and the verdict read.
function runOf({ finishedMs = null, stoppedMs = null, abortedMs = null, states = {} } = {}) {
  return {
    dir: "/run", name: "run", startedMs: NOW - 60_000,
    finishedMs, stoppedMs, abortedMs,
    tasks: Object.entries(states).map(([id, state]) => ({ id, model: "m", state, kind: "leaf" })),
  };
}

// A scripted reader: hands back one run per poll, plus the options each read was
// made with. `sleep` is a no-op that advances a fake clock, so nothing really waits.
function scripted(runs, { startMs = NOW, stepMs = 5000 } = {}) {
  let clock = startMs;
  const reads = [];
  const slept = [];
  let i = 0;
  return {
    reads,
    slept,
    opts: {
      read: (dir, o) => {
        reads.push({ dir, ...o });
        return runs[Math.min(i++, runs.length - 1)];
      },
      sleep: async (ms) => { slept.push(ms); clock += stepMs; },
      now: () => clock,
      render: (run) => `ROSTER ${run.name}`,
    },
  };
}

test("swarm wait blocks across polls until the run settles", async () => {
  const s = scripted([runOf({ states: { a: "running" } }), runOf({ states: { a: "running" } }), runOf({ finishedMs: NOW, states: { a: "ok" } })]);
  const r = await waitForRun("/run", s.opts);
  equal(r.code, EXIT_CLEAN, "a clean finish exits 0");
  equal(s.reads.length, 3, "it polls until the summary lands rather than exiting on the first read");
  equal(s.slept.length, 2, "one sleep between each pair of polls");
  equal(s.slept[0], 5000, "polls every few seconds");
});

test("swarm wait exits 0 when every leaf is ok or skipped", async () => {
  equal(settledCode(runOf({ states: { a: "ok", b: "skipped" } })), EXIT_CLEAN, "ok and skipped are both clean");
});

test("swarm wait exits 1 when a leaf failed or timed out", async () => {
  equal(settledCode(runOf({ states: { a: "ok", b: "failed" } })), EXIT_FAILED, "a failed leaf is not a clean run");
  equal(settledCode(runOf({ states: { a: "ok", b: "failed:timeout" } })), EXIT_FAILED, "a timed-out leaf is not a clean run");
  const s = scripted([runOf({ finishedMs: NOW, states: { a: "ok", b: "failed" } })]);
  equal((await waitForRun("/run", s.opts)).code, EXIT_FAILED, "the settle path reports it too");
});

test("swarm wait exits 2 when the engine died", async () => {
  const dead = runOf({ abortedMs: NOW - 60_000, states: { a: "running" } });
  const s = scripted([dead]);
  const r = await waitForRun("/run", s.opts);
  equal(r.code, EXIT_DEAD, "a dead engine is its own exit code, not a leaf failure");
  equal(s.reads.length, 1, "death settles it — no further polling");
});

test("swarm wait gives a starting run time to write its first heartbeat", async () => {
  // No heartbeat yet, so readRun reports the freshly-written run.log as aborted.
  // That is every run's first seconds, not a death.
  const starting = runOf({ abortedMs: NOW - 1000, states: { a: "running" } });
  const s = scripted([starting, starting, runOf({ finishedMs: NOW, states: { a: "ok" } })]);
  const r = await waitForRun("/run", s.opts);
  equal(r.code, EXIT_CLEAN, "a young abortedMs is a starting run, so wait keeps polling");
  equal(s.reads.length, 3, "it did not exit on the first young-abort read");
});

test("swarm wait reports a missing run.log immediately", async () => {
  const s = scripted([runOf({})]);
  s.opts.read = () => null; // readRun's answer for a dir with no run.log
  const r = await waitForRun("/nowhere", s.opts);
  equal(r.code, EXIT_FAILED, "a missing run.log is a clear error, not a hang");
  ok(r.message?.includes("run.log"), `the message must name the missing file (got ${JSON.stringify(r.message)})`);
  equal(s.slept.length, 0, "it must not poll a directory that has no run");
});

test("swarm wait prints the final roster exactly once", async () => {
  const s = scripted([runOf({ states: { a: "running" } }), runOf({ finishedMs: NOW, stoppedMs: null, states: { a: "ok" } })]);
  let renders = 0;
  const r = await waitForRun("/run", { ...s.opts, render: () => { renders++; return "ROSTER"; } });
  equal(renders, 1, "the roster is a completion notice, printed once at the end");
  equal(r.roster, "ROSTER", "the rendered roster comes back to the caller to print");
});

test("swarm wait resolves the resultsDir before reading it", async () => {
  const s = scripted([runOf({ finishedMs: NOW, states: { a: "ok" } })]);
  await waitForRun("relative/run", s.opts);
  ok(s.reads[0].dir.endsWith(join("relative", "run")) && s.reads[0].dir !== "relative/run", `the reader gets an absolute dir (got ${s.reads[0].dir})`);
});

// ── end to end, through the CLI ───────────────────────────────────────────────

function finishedRun(dir, { states = { a: "ok" } } = {}) {
  mkdirSync(join(dir, "results"), { recursive: true });
  const log = [
    `{"ts":"2026-09-05T01:00:00Z","event":"run-start","tasks":[${Object.keys(states).map((id) => `{"id":"${id}","model":"m"}`).join(",")}]}`,
    ...Object.entries(states).map(([id, state]) => `{"ts":"2026-09-05T01:02:00Z","id":"${id}","state":"${state}","durationMs":1000}`),
  ].join("\n") + "\n";
  writeFileSync(join(dir, "run.log"), log);
  // Written second: runLiveness trusts a summary only once run.log stops growing.
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ started: "2026-09-05T01:00:00Z", finished: "2026-09-05T01:02:01Z", tasks: [] }));
  return dir;
}

test("swarm wait CLI prints the roster and exits 0 for a clean run", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-wait-"));
  try {
    const run = finishedRun(join(dir, "run-1"));
    const r = runCli(["wait", run], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stderr);
    ok(r.stdout.includes("swarm ·"), `the final roster is printed (got ${JSON.stringify(r.stdout)})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("swarm wait CLI exits 1 on a failed leaf and on a missing run.log", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-wait-"));
  try {
    const bad = finishedRun(join(dir, "run-2"), { states: { a: "ok", b: "failed" } });
    const failed = runCli(["wait", bad], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(failed.status, 1, "a failed leaf exits 1");
    // Not just the code: the subcommand must have READ the run and printed its
    // roster, or an unknown-command USAGE error would satisfy the exit code too.
    ok(failed.stdout.includes("swarm ·"), `a failed run still prints its roster (got ${JSON.stringify(failed.stdout)})`);
    mkdirSync(join(dir, "empty"));
    const missing = runCli(["wait", join(dir, "empty")], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(missing.status, 1, "a missing run.log exits 1");
    ok(missing.stderr.includes("run.log"), `the error names the missing file (got ${JSON.stringify(missing.stderr)})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
