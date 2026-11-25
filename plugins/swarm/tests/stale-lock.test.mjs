// A git process killed mid-write leaves a zero-byte `<x>.lock` behind and every later ref
// write in that repo fails. Prune reads that lock out of git's own refusal and says whether
// it is stale — it never removes one itself, because a live writer's lock is the ref store.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyLock, gitRunning, lockPath } from "../src/stale-lock.mjs";

const THRESHOLD_MS = 60_000;

// A real lockfile with a back-dated mtime: `utimesSync` rather than a sleep, so the age is
// exact and the row costs no wall-clock.
function lockFile({ bytes = 0, ageMs = 120_000, name = "packed-refs.lock" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "swarm-stale-lock-"));
  const path = join(dir, name);
  writeFileSync(path, "x".repeat(bytes));
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
  return { path, drop: () => rmSync(dir, { recursive: true, force: true }) };
}

test("lockPath: git's refusal names the lock, Windows drive paths included", () => {
  const windows = "error: could not delete reference refs/heads/victim: Unable to create "
    + "'C:/Users/x/repo/.git/packed-refs.lock': File exists.\n\nAnother git process seems to be running";
  equal(lockPath(windows), "C:/Users/x/repo/.git/packed-refs.lock");
  equal(lockPath("fatal: Unable to create '/repo/.git/refs/heads/victim.lock': File exists."),
    "/repo/.git/refs/heads/victim.lock");
});

test("lockPath: a refusal that names no lock returns null", () => {
  equal(lockPath("error: cannot delete branch 'b' used by worktree at 'C:/repo/tree'"), null);
  equal(lockPath("fatal: 'C:/repo/tree' is a locked working tree"), null);
  equal(lockPath(""), null);
  equal(lockPath(null), null);
});

test("classifyLock: an empty lock past the threshold with no git running is stale", () => {
  const { path, drop } = lockFile({ ageMs: 120_000 });
  try {
    const info = classifyLock(path, { fs, now: Date.now(), gitRunning: () => false });
    equal(info.state, "stale");
    equal(info.size, 0);
    ok(info.ageMs >= 120_000 && info.ageMs < 130_000, `age reads ${info.ageMs} ms`);
  } finally { drop(); }
});

test("classifyLock: the same stale-looking lock with a git process running is held", () => {
  const { path, drop } = lockFile({ ageMs: 120_000 });
  try {
    equal(classifyLock(path, { fs, now: Date.now(), gitRunning: () => true }).state, "held");
  } finally { drop(); }
});

test("classifyLock: a lock younger than the threshold is held even with no git running", () => {
  const { path, drop } = lockFile({ ageMs: 10_000 });
  try {
    const info = classifyLock(path, { fs, now: Date.now(), gitRunning: () => false });
    equal(info.state, "held");
    ok(info.ageMs < THRESHOLD_MS, `age reads ${info.ageMs} ms`);
  } finally { drop(); }
});

test("classifyLock: a lock with content is held however old it is", () => {
  const { path, drop } = lockFile({ bytes: 12, ageMs: 120_000 });
  try {
    const info = classifyLock(path, { fs, now: Date.now(), gitRunning: () => false });
    equal(info.state, "held");
    equal(info.size, 12);
  } finally { drop(); }
});

test("classifyLock: a probe that throws or cannot run counts as unknown, so the lock is held", () => {
  const { path, drop } = lockFile({ ageMs: 120_000 });
  try {
    const thrown = classifyLock(path, { fs, now: Date.now(), gitRunning: () => { throw new Error("no probe"); } });
    equal(thrown.state, "held");
    const unknown = classifyLock(path, { fs, now: Date.now(), gitRunning: () => gitRunning(() => ({ status: 2, stdout: "" }), "linux") });
    equal(unknown.state, "held");
  } finally { drop(); }
});

test("classifyLock: a lock cleared since the git call is gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-stale-lock-"));
  try {
    equal(classifyLock(join(dir, "packed-refs.lock"), { fs, now: Date.now(), gitRunning: () => false }).state, "gone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gitRunning: win32 asks tasklist, elsewhere pgrep -x git", () => {
  const calls = [];
  const busy = (cmd, args) => {
    calls.push({ cmd, args });
    return cmd === "tasklist"
      ? { status: 0, stdout: "git.exe                       1234 Console                    1     12,345 K\n" }
      : { status: 0, stdout: "4242\n" };
  };
  equal(gitRunning(busy, "win32"), true);
  deepEqual(calls.at(-1), { cmd: "tasklist", args: ["/FI", "IMAGENAME eq git.exe", "/NH"] });
  equal(gitRunning(busy, "linux"), true);
  deepEqual(calls.at(-1), { cmd: "pgrep", args: ["-x", "git"] });
});

test("gitRunning: tasklist's no-match line is idle, and a failure to run is unknown", () => {
  const idle = () => ({ status: 0, stdout: "INFO: No tasks are running which match the specified criteria.\n" });
  equal(gitRunning(idle, "win32"), false);
  equal(gitRunning(() => ({ status: 1, stdout: "" }), "linux"), false);
  equal(gitRunning(() => ({ status: 2, stdout: "" }), "linux"), null);
  equal(gitRunning(() => ({ status: 1, stdout: "", stderr: "tasklist failed" }), "win32"), null);
  equal(gitRunning(() => ({ status: 0, stdout: "", error: new Error("ENOENT") }), "win32"), null);
  equal(gitRunning(() => ({ status: null, stdout: "" }), "win32"), null);
});
