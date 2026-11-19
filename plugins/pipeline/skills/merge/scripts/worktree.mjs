// worktree.mjs — the throwaway worktree a merge owns.
//
// The squash, the plan writes and the close commit run here. The rebase runs in
// the feature worktree, parking writes a ref in the shared repo, and the land
// fast-forwards the shared checkout. Detached at the target's tip, so no branch
// is checked out twice and the squash builds on what origin holds.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitError, runGit } from "./rebase.mjs";
import { featureWorktreePath } from "../../../src/worktree-paths.mjs";

export class MergeWorktreeExistsError extends Error {}

// One path per merge invocation (`merge_<YYYYMMDD-HHMM>`), resolved through the
// canonical per-feature template. An existing path is refused, not reclaimed:
// it may belong to a live run, and removing it would delete that run's work.
export function createMergeWorktree({ project, projectDir, sessionSlug, sha }) {
  const path = featureWorktreePath({ project, projectRoot: projectDir, feature: sessionSlug });
  if (existsSync(path)) {
    throw new MergeWorktreeExistsError(
      `merge worktree path already exists: ${path} — refusing to reuse or remove it (it may belong to a live run)`,
    );
  }
  const add = runGit(["worktree", "add", "--detach", path, sha], projectDir, { check: false });
  if (add.code !== 0) {
    throw new GitError(`could not create merge worktree at ${path}: ${add.stderr.trim()}`);
  }

  return {
    path,
    // Re-point the worktree at what origin now holds, so the next branch in the
    // same invocation builds on a pushed squash rather than a stale base.
    resync(ref) {
      if (!existsSync(path)) return false;
      runGit(["fetch", "origin"], path, { check: false });
      if (runGit(["rev-parse", "--verify", "--quiet", ref], path, { check: false }).code !== 0) return false;
      const co = runGit(["checkout", "--detach", ref], path, { check: false });
      if (co.code !== 0) throw new GitError(`resync to ${ref} failed: ${co.stderr.trim()}`);
      return true;
    },
    // Non-fatal: the worktree may already be gone, and a failed cleanup must
    // never turn a completed merge into a failure.
    remove() {
      if (!existsSync(path)) return;
      try {
        runGit(["worktree", "remove", "--force", path], projectDir, { check: false });
        runGit(["worktree", "prune"], projectDir, { check: false });
      } catch { /* best effort */ }
    },
  };
}

// Rebase fallback: no feature worktree holds the branch, so replay it in a
// detached throwaway worktree. The caller update-refs the branch to the result;
// this module only owns the workspace lifetime.
export async function withDetachedWorktree(projectDir, ref, fn) {
  const root = mkdtempSync(join(tmpdir(), "pipeline-rebase-"));
  const path = join(root, "wt");
  const add = runGit(["worktree", "add", "--detach", path, ref], projectDir, { check: false });
  if (add.code !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new GitError(`could not create a detached worktree at ${path}: ${add.stderr.trim()}`);
  }
  try {
    return await fn(path);
  } finally {
    try {
      runGit(["worktree", "remove", "--force", path], projectDir, { check: false });
      runGit(["worktree", "prune"], projectDir, { check: false });
    } catch { /* best effort */ }
    rmSync(root, { recursive: true, force: true });
  }
}
