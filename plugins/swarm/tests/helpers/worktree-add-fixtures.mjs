import { mkdtempSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { git } from "./worktree-fixtures.mjs";

// Helpers shared by the worktree-add test files: the retry rows and the debris
// clear rows both drive the same lock paths.

// worktree.mjs's runner shape: a result object, never a throw.
export function gitRun(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

export function lockPathFor(repo, branch) {
  return resolve(repo, git(["rev-parse", "--git-path", `refs/heads/${branch}.lock`], repo));
}

export function ageLock(lock, ms) {
  const old = new Date(Date.now() - ms);
  utimesSync(lock, old, old);
}

export function scratch() {
  return mkdtempSync(join(tmpdir(), "swarm-wt-debris-"));
}
