import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { WORKTREE_ADD_TIMEOUT_MS } from "../../src/worktree.mjs";

// Fixtures shared by the worktree test files. They live here rather than in
// worktree.test.mjs because importing a .test.mjs from another .test.mjs
// re-registers and re-runs its rows in the importing file's process.

export function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return (r.stdout || "").trim();
}

export function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), "swarm-wt-repo-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, windowsHide: true });
  writeFileSync(join(repo, "a.txt"), "hello\n");
  spawnSync("git", ["add", "."], { cwd: repo, windowsHide: true });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], { cwd: repo, windowsHide: true });
  return repo;
}

export function cleanup(...dirs) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

export function commitAll(cwd, msg) {
  spawnSync("git", ["add", "."], { cwd, windowsHide: true });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", msg], { cwd, windowsHide: true });
}

// git holds the worktree dir open; remove it before rmSync'ing the repo.
export function dropWorktree(repo, path) {
  spawnSync("git", ["worktree", "remove", "--force", path], { cwd: repo, windowsHide: true });
}

export const CFG = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "x", allowedRoots: [] },
  resultInlineCap: 4000,
  worktreeBranchPrefix: "swarm/",
};

// `base` is the run's pinned dispatch commit — prepareIsolation reads HEAD never,
// only what the run captured (run-bases.mjs). Pin the CURRENT HEAD here, which is
// what a real capture at this moment would have recorded.
export const ADD = (repo) => ({ addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: git(["rev-parse", "HEAD"], repo) });
