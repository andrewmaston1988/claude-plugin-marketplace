// A planted, back-dated `.git/packed-refs.lock` reproduces the refusal a killed git leaves
// behind. Prune must name that lock as stale instead of leaving the operator to guess
// whether removing it is safe.
import "./helpers/isolate-home.mjs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCliInProcess } from "./helpers/cli.mjs";
import { gitOut } from "./helpers/cli-fixture.mjs";
import { runScopeKey } from "../src/worktree.mjs";
import { dropSnapPrune, pruneFixture, writeFinishedRun } from "./helpers/prune-fixture.mjs";

// Captured before any patch: a live ESM binding would give the stub back after the sync.
const REAL_SPAWN_SYNC = childProcess.spawnSync;

// The suite runs test files in parallel, so a real tasklist/pgrep would find another file's
// git process and the diagnosis would depend on the weather. Pin the probe's answer.
function probeIsIdle() {
  childProcess.spawnSync = (cmd, args, opts) => {
    if (cmd === "tasklist") {
      return { status: 0, stdout: "INFO: No tasks are running which match the specified criteria.\n", stderr: "" };
    }
    if (cmd === "pgrep") return { status: 1, stdout: "", stderr: "" };
    return REAL_SPAWN_SYNC(cmd, args, opts);
  };
  syncBuiltinESMExports();
  return () => {
    childProcess.spawnSync = REAL_SPAWN_SYNC;
    syncBuiltinESMExports();
  };
}

// A landed branch-only row — it sits at the base the default branch already holds — with the
// 0-byte lock a killed git leaves at the end of a merge.
function staleLockRun() {
  const f = pruneFixture();
  const scope = runScopeKey(f.resultsDir);
  const branch = `swarm/${scope}/landed`;
  const made = REAL_SPAWN_SYNC("git", ["branch", branch, f.sha], { cwd: f.repo, windowsHide: true });
  equal(made.status, 0, String(made.stderr));
  writeFinishedRun(f.resultsDir, []);
  const lock = join(f.repo, ".git", "packed-refs.lock");
  writeFileSync(lock, "");
  const when = new Date(Date.now() - 120_000);
  utimesSync(lock, when, when);
  return { f, branch, lock };
}

const pruneArgs = (f) => ["prune", f.resultsDir];
const pruneOpts = (f) => ({ cwd: f.dir, env: { SWARM_HOME: join(f.dir, "home") } });
// git prints the path with forward slashes on every platform.
const gitSpelling = (path) => path.replaceAll("\\", "/");

test("a stale lock is named as safe to remove, and the summary points at it", async () => {
  const { f, branch, lock } = staleLockRun();
  const restore = probeIsIdle();
  try {
    const r = await runCliInProcess(pruneArgs(f), pruneOpts(f));
    equal(r.status, 1, r.stdout + r.stderr);
    ok(!/freed/.test(r.stdout), `a refused row is never printed as freed: ${r.stdout}`);
    ok(r.stderr.includes(gitSpelling(lock)), `the lock path is named: ${r.stderr}`);
    ok(/stale git lock/.test(r.stderr), `the lock is named as stale: ${r.stderr}`);
    ok(/safe to remove/.test(r.stderr), `the remedy is spelled out: ${r.stderr}`);
    ok(/the stale lock .*packed-refs\.lock/.test(r.stderr),
      `the summary names the lock rather than "clear what git names above": ${r.stderr}`);
    ok(!/clear what git names above/.test(r.stderr), r.stderr);
    ok(gitOut(["branch", "--list", branch], f.repo), "prune never deletes the lock or the row");
  } finally {
    restore();
    dropSnapPrune(f);
  }
});

test("once the lock is removed the same prune exits 0 and removes the row", async () => {
  const { f, branch, lock } = staleLockRun();
  const restore = probeIsIdle();
  try {
    const first = await runCliInProcess(pruneArgs(f), pruneOpts(f));
    equal(first.status, 1, first.stdout + first.stderr);
    rmSync(lock, { force: true });
    const second = await runCliInProcess(pruneArgs(f), pruneOpts(f));
    equal(second.status, 0, second.stdout + second.stderr);
    equal(gitOut(["branch", "--list", branch], f.repo), "", "the row is removed once the lock is gone");
  } finally {
    restore();
    dropSnapPrune(f);
  }
});
