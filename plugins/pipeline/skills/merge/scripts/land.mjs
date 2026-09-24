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

// A merged target that stays local is discarded by the next sync to origin.
// Returns false only when a push was owed and origin did not end up at HEAD.
export function pushTarget(projectDir, targetBranch, { log, err }) {
  if (runGit(["remote", "get-url", "origin"], projectDir, { check: false }).code !== 0) {
    log("[7b] No origin remote — nothing to push");
    return true;
  }
  const push = runGit(["push", "origin", targetBranch], projectDir, { check: false });
  const local = runGit(["rev-parse", targetBranch], projectDir, { check: false }).stdout.trim();
  const remote = runGit(["ls-remote", "origin", `refs/heads/${targetBranch}`], projectDir, { check: false }).stdout.split(/\s/)[0];
  if (push.code !== 0 || remote !== local) {
    err(`BLOCKER: push of ${targetBranch} to origin failed — the merge is local only; push it by hand: ${push.stderr.trim()}`);
    return false;
  }
  log(`[7b] Pushed ${targetBranch} to origin (${local.slice(0, 7)})`);
  return true;
}
