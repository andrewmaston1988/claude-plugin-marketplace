// What happens to a branch once its merge has landed: its worktree and local
// branch go, and the target branch goes to origin.
import { existsSync } from "node:fs";
import { runGit, gitWorktreeWithRetry } from "./rebase.mjs";

// Non-fatal throughout: an on_merge hook or a PR merge may already have removed
// the branch, which is the state we wanted anyway.
export async function cleanupBranch(projectDir, branch, wt, { log, err }) {
  if (existsSync(wt)) {
    const r = await gitWorktreeWithRetry(projectDir, "remove", "--force", wt);
    if (r.code !== 0) err(`[5] WARN: worktree remove failed for ${wt}: ${r.stderr.trim()}`);
    else log(`[5] Removed worktree: ${wt}`);
  }
  if (runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], projectDir, { check: false }).code !== 0) return;
  const del = runGit(["branch", "-D", branch], projectDir, { check: false });
  if (del.code !== 0) err(`[5] WARN: branch delete failed for ${branch}: ${del.stderr.trim()}`);
  else log(`[5] Deleted branch: ${branch}`);
}

// The push is complete only once origin contains the merged HEAD.
export function pushTarget(projectRoot, targetBranch, { log, err, git = runGit }) {
  if (git(["remote", "get-url", "origin"], projectRoot, { check: false }).code !== 0) {
    log("[7b] No origin remote — nothing to push");
    return true;
  }
  const targetRef = `refs/heads/${targetBranch}`;
  const trackingRef = `refs/remotes/origin/${targetBranch}`;
  const head = git(["rev-parse", "--verify", "HEAD"], projectRoot, { check: false });
  if (head.code !== 0) {
    err(`BLOCKER: could not resolve HEAD before pushing ${targetBranch}: ${head.stderr.trim()}`);
    return false;
  }
  const commit = head.stdout.trim();
  const push = git(["push", "origin", `${commit}:${targetRef}`], projectRoot, { check: false });
  if (push.code !== 0) {
    err(`BLOCKER: push of ${targetBranch} to origin failed — the merge is local only; push it by hand: ${push.stderr.trim()}`);
    return false;
  }
  // Refresh the tracking ref from the fetch URL even when push used a different URL.
  const fetch = git(["fetch", "origin", `+${targetRef}:${trackingRef}`], projectRoot, { check: false });
  if (fetch.code !== 0) {
    err(`BLOCKER: push verification for ${targetBranch} could not fetch origin: ${fetch.stderr.trim()}`);
    return false;
  }
  const landed = git(["merge-base", "--is-ancestor", commit, trackingRef], projectRoot, { check: false });
  if (landed.code !== 0) {
    err(`BLOCKER: push verification failed for ${targetBranch}: ${commit} was not confirmed on origin/${targetBranch}. ${landed.stderr.trim()}`.trimEnd());
    return false;
  }
  log(`[7b] Pushed ${targetBranch} to origin (${commit.slice(0, 7)})`);
  return true;
}
