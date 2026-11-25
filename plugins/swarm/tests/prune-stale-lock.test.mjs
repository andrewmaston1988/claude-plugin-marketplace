// Fixtures plant a `.git/packed-refs.lock`, which is the exact refusal a killed git leaves.
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
function pinProbe(answer) {
  childProcess.spawnSync = (cmd, args, opts) => {
    if (cmd === "tasklist") return answer === "busy"
      ? { status: 0, stdout: "git.exe                       1234 Console                    1     12,345 K\n", stderr: "" }
      : { status: 0, stdout: "INFO: No tasks are running which match the specified criteria.\n", stderr: "" };
    if (cmd === "pgrep") return answer === "busy"
      ? { status: 0, stdout: "4242\n", stderr: "" }
      : { status: 1, stdout: "", stderr: "" };
    return REAL_SPAWN_SYNC(cmd, args, opts);
  };
  syncBuiltinESMExports();
  return () => {
    childProcess.spawnSync = REAL_SPAWN_SYNC;
    syncBuiltinESMExports();
  };
}

// A landed branch-only row — it sits at the base the default branch already holds — with a
// back-dated lock file of `bytes` length.
function lockRun({ bytes = 0 } = {}) {
  const f = pruneFixture();
  const scope = runScopeKey(f.resultsDir);
  const branch = `swarm/${scope}/landed`;
  const made = REAL_SPAWN_SYNC("git", ["branch", branch, f.sha], { cwd: f.repo, windowsHide: true });
  equal(made.status, 0, String(made.stderr));
  writeFinishedRun(f.resultsDir, []);
  const lock = join(f.repo, ".git", "packed-refs.lock");
  writeFileSync(lock, "x".repeat(bytes));
  const when = new Date(Date.now() - 120_000);
  utimesSync(lock, when, when);
  return { f, branch, lock };
}

const pruneArgs = (f) => ["prune", f.resultsDir];
const pruneOpts = (f) => ({ cwd: f.dir, env: { SWARM_HOME: join(f.dir, "home") } });
// git prints the path with forward slashes on every platform.
const gitSpelling = (path) => path.replaceAll("\\", "/");

test("a stale lock is named against this host, and the summary points at it", async () => {
  const { f, branch, lock } = lockRun();
  const restore = pinProbe("idle");
  try {
    const r = await runCliInProcess(pruneArgs(f), pruneOpts(f));
    equal(r.status, 1, r.stdout + r.stderr);
    ok(!/freed/.test(r.stdout), `a refused row is never printed as freed: ${r.stdout}`);
    ok(r.stderr.includes(gitSpelling(lock)), `the lock path is named: ${r.stderr}`);
    ok(/stale git lock/.test(r.stderr), `the lock is named as stale: ${r.stderr}`);
    // A remote writer is invisible to this host's probe, so the remedy needs its own
    // confirmation step rather than reading "no local git = safe".
    ok(/no git process is running on this host/.test(r.stderr), `the observation is scoped to the host: ${r.stderr}`);
    ok(/confirm every writer has stopped/.test(r.stderr), `removal needs confirmation: ${r.stderr}`);
    ok(!/safe to remove/.test(r.stderr), `the host check alone never says safe: ${r.stderr}`);
    ok(/the stale lock .*packed-refs\.lock/.test(r.stderr),
      `the summary names the lock rather than "clear what git names above": ${r.stderr}`);
    const summaryLine = r.stderr.split("\n").find((line) => /the stale lock/.test(line)) ?? "";
    ok(/confirm every writer has stopped/.test(summaryLine),
      `the summary carries the confirmation too: ${r.stderr}`);
    ok(!/clear what git names above/.test(r.stderr), r.stderr);
    ok(gitOut(["branch", "--list", branch], f.repo), "prune never deletes the lock or the row");
  } finally {
    restore();
    dropSnapPrune(f);
  }
});

test("a lock behind a running git is reported as unverified, not owned by that git", async () => {
  const { f } = lockRun();
  const restore = pinProbe("busy");
  try {
    const r = await runCliInProcess(pruneArgs(f), pruneOpts(f));
    equal(r.status, 1, r.stdout + r.stderr);
    ok(/git is running on this host/.test(r.stderr), `the probe's answer is named: ${r.stderr}`);
    ok(/unverified/.test(r.stderr), `an unrelated git does not own the lock: ${r.stderr}`);
    ok(!/stale git lock/.test(r.stderr), `no stale claim while git runs: ${r.stderr}`);
    ok(!/the stale lock/.test(r.stderr), `the summary stays generic: ${r.stderr}`);
  } finally {
    restore();
    dropSnapPrune(f);
  }
});

test("a lock with content points at its owner instead of a retry that changes nothing", async () => {
  const { f } = lockRun({ bytes: 12 });
  const restore = pinProbe("idle");
  try {
    const r = await runCliInProcess(pruneArgs(f), pruneOpts(f));
    equal(r.status, 1, r.stdout + r.stderr);
    ok(/12 bytes/.test(r.stderr), `the size is reported: ${r.stderr}`);
    ok(/check whether that writer is alive/.test(r.stderr), `the remedy is to verify the owner: ${r.stderr}`);
    ok(!/wait a minute/.test(r.stderr), `a timed wait cannot change the content verdict: ${r.stderr}`);
  } finally {
    restore();
    dropSnapPrune(f);
  }
});

test("once the lock is removed the same prune exits 0 and removes the row", async () => {
  const { f, branch, lock } = lockRun();
  const restore = pinProbe("idle");
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
