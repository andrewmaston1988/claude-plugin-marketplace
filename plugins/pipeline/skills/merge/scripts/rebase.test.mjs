// rebase.test.mjs — where step 0a rebases, and the index.lock retry.
//
// The rebase must never run in the shared checkout while another session holds
// the branch checked out in the phase-3b feature worktree, and the lock retry
// must find the lock in a linked worktree, where `.git` is a file.
import "../../../tests/helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, basename, dirname, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  step0aRebase, withLockWait, precheckLockForRebase, runGit,
} from "./rebase.mjs";
import { featureWorktreePath } from "../../../src/worktree-paths.mjs";

function git(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function gitMaybe(cwd, ...args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

// master: seed. autonomous/feat-x: one commit ahead. master then advances, so
// the branch is behind the target and a rebase has real work to do.
function makeRepo() {
  const tmp = mkdtempSync(join(tmpdir(), "rebase-test-"));
  const repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "--initial-branch=master");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "init\n", "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "seed");
  git(repo, "checkout", "-b", "autonomous/feat-x");
  writeFileSync(join(repo, "feat.txt"), "feat\n", "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "feat");
  git(repo, "checkout", "master");
  writeFileSync(join(repo, "target.txt"), "target moved\n", "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "target");
  return { tmp, repo };
}

function reflogCount(repo) {
  return git(repo, "reflog", "show", "HEAD", "--format=%H").split("\n").filter(Boolean).length;
}

function addLinkedWorktree(repo, path, ref) {
  mkdirSync(dirname(path), { recursive: true });
  git(repo, "worktree", "add", "--detach", path, ref);
  return path;
}

// The lock path git itself names for this checkout — absolute on Windows,
// cwd-relative on some git builds, so resolve both the same way.
function lockPath(cwd) {
  const raw = git(cwd, "rev-parse", "--git-path", "index.lock");
  return isAbsolute(raw) ? raw : join(cwd, raw);
}

// ── A10 — the rebase runs in the phase-3b feature worktree ───────────────────

test("A10: step0aRebase rebases in the feature worktree, not the shared checkout", async () => {
  const { tmp, repo } = makeRepo();
  try {
    const wt = featureWorktreePath({ project: basename(repo), projectRoot: repo, feature: "feat-x" });
    mkdirSync(dirname(wt), { recursive: true });
    git(repo, "worktree", "add", wt, "autonomous/feat-x");

    const before = reflogCount(repo);
    const okResult = await step0aRebase(repo, ["autonomous/feat-x"], "master");

    equal(okResult, true, "step0aRebase must succeed when the feature worktree holds the branch");
    equal(gitMaybe(repo, "merge-base", "--is-ancestor", "master", "autonomous/feat-x").status, 0,
      "the rebased branch must contain the target");
    equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "master",
      "the shared checkout must stay on its branch");
    equal(reflogCount(repo), before, "the shared checkout's HEAD reflog must not change");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── A10b — a branch the feature path cannot derive ───────────────────────────
// Rows may declare any branch name; the worktree directory stays plan-stem
// derived, so featureWorktreePath misses `anm/x` entirely. Resolving the holder
// from `git worktree list --porcelain` is what keeps its index consistent.

test("A10b: a non-derived branch is rebased in the worktree that holds it, leaving its index clean", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rebase-nonderived-"));
  const repo = join(tmp, "repo");
  try {
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "--initial-branch=master");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "README.md"), "init\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "seed");
    git(repo, "checkout", "-b", "anm/x");
    writeFileSync(join(repo, "x.txt"), "x\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "x");
    git(repo, "checkout", "master");
    writeFileSync(join(repo, "target.txt"), "target moved\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "target");

    // Deliberately nowhere near featureWorktreePath's default for the project.
    const wt = join(tmp, "elsewhere", "held");
    mkdirSync(dirname(wt), { recursive: true });
    git(repo, "worktree", "add", wt, "anm/x");
    const before = reflogCount(repo);

    const okResult = await step0aRebase(repo, ["anm/x"], "master");

    equal(okResult, true, "step0aRebase must succeed for a branch a worktree holds");
    equal(gitMaybe(repo, "merge-base", "--is-ancestor", "master", "anm/x").status, 0,
      "the rebased branch must contain the target");
    equal(git(wt, "status", "--porcelain"), "",
      "the holding worktree's index must still match its branch after the rebase");
    equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "master",
      "the shared checkout must stay on its branch");
    equal(reflogCount(repo), before, "the shared checkout's HEAD reflog must not change");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── A11 — the index.lock retry resolves through rev-parse --git-path ─────────

test("A11: the lock retry finds index.lock in a linked worktree and waits it out", async () => {
  const { tmp, repo } = makeRepo();
  try {
    const wt = addLinkedWorktree(repo, join(tmp, "linked"), "HEAD");
    const lock = lockPath(wt);
    writeFileSync(lock, "", "utf8");

    const started = Date.now();
    const release = (async () => {
      await sleep(400);
      rmSync(lock, { force: true });
    })();

    let thrown;
    let elapsed;
    try {
      await withLockWait(() => runGit(["add", "-A"], wt, { check: true }), wt);
    } catch (e) {
      thrown = e;
    } finally {
      elapsed = Date.now() - started;
    }
    await release;

    equal(thrown, undefined, `a lock that clears must be retried, not fail at once: ${thrown?.message}`);
    ok(elapsed >= 400, "the call must have waited for the lock rather than failing immediately");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("A11 (precheck): precheckLockForRebase waits on a linked worktree's lock", async () => {
  const { tmp, repo } = makeRepo();
  try {
    const wt = addLinkedWorktree(repo, join(tmp, "linked"), "HEAD");
    const lock = lockPath(wt);
    writeFileSync(lock, "", "utf8");

    const started = Date.now();
    const release = (async () => {
      await sleep(300);
      rmSync(lock, { force: true });
    })();

    let thrown;
    let elapsed;
    try {
      await precheckLockForRebase(wt, 2000);
    } catch (e) {
      thrown = e;
    } finally {
      elapsed = Date.now() - started;
    }
    await release;

    equal(thrown, undefined, `the precheck must wait for the lock to clear: ${thrown?.message}`);
    ok(elapsed >= 250, "the precheck must have waited, not returned vacuously");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
