// Step 0a — git rebase + index.lock retry helpers.
// Mirrors merge.py: run_git, _with_lock_wait, _precheck_lock_for_rebase,
// _git_*_with_retry, _detect_default_branch, step_0a_rebase.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export class GitError extends Error {}

// ── Git subprocess ─────────────────────────────────────────────────────────────

export function runGit(args, cwd, { check = true, capture = true } = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: capture ? ["pipe", "pipe", "pipe"] : ["inherit", "inherit", "inherit"],
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (check && result.status !== 0) {
    throw new GitError(`git ${args.join(" ")} failed in ${cwd}:\n${stderr.trim()}`);
  }
  return { code: result.status ?? 0, stdout, stderr };
}

// ── Lock retry ─────────────────────────────────────────────────────────────────

export async function withLockWait(fn, cwd, { maxRetries = 5, backoffMs = 500, maxWaitMs = 2500 } = {}) {
  const lockFile = join(cwd, ".git", "index.lock");
  let attempt = 0;
  let totalWaitMs = 0;

  while (attempt < maxRetries) {
    try {
      return fn();
    } catch (e) {
      if (e instanceof GitError && existsSync(lockFile) && totalWaitMs < maxWaitMs) {
        attempt++;
        let waitMs = backoffMs * attempt;
        if (totalWaitMs + waitMs > maxWaitMs) waitMs = maxWaitMs - totalWaitMs;
        await sleep(waitMs);
        totalWaitMs += waitMs;
        continue;
      }
      if (e instanceof GitError && existsSync(lockFile)) {
        throw new GitError(
          `git operation failed: .git/index.lock persists after ${maxWaitMs}ms. ` +
          `Lock file: ${lockFile}. Diagnose with: Get-Process git`,
        );
      }
      throw e;
    }
  }
}

export async function precheckLockForRebase(cwd, maxWaitMs = 2500) {
  const lockFile = join(cwd, ".git", "index.lock");
  const start = Date.now();
  while (existsSync(lockFile) && Date.now() - start < maxWaitMs) {
    await sleep(100);
  }
  if (existsSync(lockFile)) {
    throw new GitError(
      `index.lock still held before rebase after ${maxWaitMs}ms. ` +
      `Lock file: ${lockFile}. Diagnose with: Get-Process git`,
    );
  }
}

// ── Lock-retrying git helpers ──────────────────────────────────────────────────

export async function gitCommitWithRetry(cwd, ...args) {
  return withLockWait(() => runGit(["commit", ...args], cwd, { check: true }), cwd);
}

export async function gitAddWithRetry(cwd, ...paths) {
  return withLockWait(() => runGit(["add", ...paths], cwd, { check: true }), cwd);
}

export async function gitMergeSquashWithRetry(cwd, branch) {
  return withLockWait(() => runGit(["merge", "--squash", branch], cwd, { check: false }), cwd);
}

export async function gitWorktreeWithRetry(cwd, ...args) {
  return withLockWait(() => runGit(["worktree", ...args], cwd, { check: false }), cwd);
}

export async function gitCheckoutWithRetry(cwd, ...args) {
  return withLockWait(() => runGit(["checkout", ...args], cwd, { check: false }), cwd);
}

// ── Branch detection ───────────────────────────────────────────────────────────

export function branchExists(projectDir, branch) {
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: projectDir,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return r.status === 0;
}

export function detectDefaultBranch(projectDir) {
  const candidates = [];

  const sym = spawnSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
    cwd: projectDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  if (sym.status === 0) candidates.push(sym.stdout.trim().split("/").pop());

  const cfg = spawnSync("git", ["config", "init.defaultBranch"], {
    cwd: projectDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  if (cfg.status === 0 && cfg.stdout.trim()) candidates.push(cfg.stdout.trim());

  candidates.push("main", "master");

  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (branchExists(projectDir, c)) return c;
  }
  throw new GitError(
    `no usable default branch in ${projectDir}: tried ` +
    `${[...seen].map(s => `'${s}'`).join(", ")}, none exist locally`,
  );
}

// ── Step 0a ────────────────────────────────────────────────────────────────────

export async function step0aRebase(projectDir, branches, targetBranch = "main") {
  for (const branch of branches) {
    const slug = branch.startsWith("autonomous/") ? branch.slice("autonomous/".length) : branch;
    const wt = join(dirname(projectDir), `${basename(projectDir)}-wt`, `autonomous-${slug}`);
    const target = existsSync(wt) ? wt : projectDir;

    process.stdout.write(`[0a] Rebasing ${branch} on ${targetBranch} (in ${target})\n`);

    const co = await gitCheckoutWithRetry(target, branch);
    if (co.code !== 0) {
      process.stderr.write(`BLOCKER: cannot checkout ${branch} in ${target}\n`);
      process.stderr.write(co.stderr.trim() + "\n");
      return false;
    }

    runGit(["fetch", "origin", targetBranch], target, { check: false });

    try {
      await precheckLockForRebase(target);
    } catch (e) {
      process.stderr.write(`BLOCKER: ${e.message}\n`);
      return false;
    }

    const result = runGit(["rebase", targetBranch], target, { check: false });
    if (result.code !== 0) {
      runGit(["rebase", "--abort"], target, { check: false });
      process.stderr.write(`BLOCKER: rebase conflict in ${branch}\n`);
      process.stderr.write((result.stderr.trim() || result.stdout.trim()) + "\n");
      return false;
    }
  }
  return true;
}
