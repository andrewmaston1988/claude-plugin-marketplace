import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { WORKTREE_ADD_TIMEOUT_MS } from "../../src/worktree.mjs";
import { commitAllInRepo, gitInRepo, initGitRepo } from "./scheduler-fixtures.mjs";

// Fixtures shared by the worktree test files. They live here rather than in
// worktree.test.mjs because importing a .test.mjs from another .test.mjs
// re-registers and re-runs its rows in the importing file's process.

// The repo fixtures have one implementation, in scheduler-fixtures.mjs. These are
// the names the worktree tests already import.
export const git = gitInRepo;
export const initRepo = initGitRepo;
export const commitAll = commitAllInRepo;

export function cleanup(...dirs) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
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
