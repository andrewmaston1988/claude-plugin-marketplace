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
// Returns false only when a push was owed and origin did not end up at `sha`.
// `cwd` may be a linked worktree: remotes are shared with the main checkout,
// and the push never needs the local target ref to exist.
export function pushTarget(cwd, targetBranch, { log, err, sha }) {
  if (!sha) throw new Error("pushTarget: sha is required (push <sha>:refs/heads/<target>)");
  if (runGit(["remote", "get-url", "origin"], cwd, { check: false }).code !== 0) {
    log("[7b] No origin remote — nothing to push");
    return true;
  }
  const push = runGit(["push", "origin", `${sha}:refs/heads/${targetBranch}`], cwd, { check: false });
  const remote = runGit(["ls-remote", "origin", `refs/heads/${targetBranch}`], cwd, { check: false })
    .stdout.trim().split(/\s/)[0];
  if (push.code !== 0 || remote !== sha) {
    err(`BLOCKER: push of ${targetBranch} to origin failed — the merge is not on origin; retry the push by hand: ${push.stderr.trim()}`);
    return false;
  }
  log(`[7b] Pushed ${targetBranch} to origin (${sha.slice(0, 7)})`);
  return true;
}

// A squash whose worktree is about to be removed must stay reachable from a
// ref, or `git worktree remove` leaves the commit findable only by fsck.
export function parkSquash(projectDir, targetBranch, sha) {
  return runGit(["update-ref", `refs/merge/${targetBranch}`, sha], projectDir, { check: false }).code === 0;
}

function lines(out) {
  return String(out).split("\n").map((l) => l.trim()).filter(Boolean);
}

// Paths the landed sha touches. `--no-renames` is load-bearing: with rename
// detection on, a rename lists only its destination and an overlap on the
// source path — the incident's staged `git mv` — goes unseen.
export function changedPaths(projectDir, sha) {
  const r = runGit(["diff", "--name-only", "--no-renames", "HEAD", sha], projectDir, { check: false });
  return r.code === 0 ? lines(r.stdout) : [];
}

// Paths the shared checkout has modified but uncommitted: modified tracked
// files and untracked files the land would create. Used only to name the
// blocking paths in a refusal report.
function uncommittedPaths(projectDir) {
  return [
    ...lines(runGit(["diff", "--name-only"], projectDir, { check: false }).stdout),
    ...lines(runGit(["ls-files", "--others", "--exclude-standard"], projectDir, { check: false }).stdout),
  ];
}

// The only code left that mutates the shared checkout. Four guards, in order;
// the first that fires returns without moving anything. Each guard names the
// input that makes it refuse:
//   1. HEAD is not the target            -> `git merge --ff-only` would move the wrong branch (case 8)
//   2. the sha is not a descendant of HEAD -> not a fast-forward
//   3. a staged path overlaps the merge   -> --ff-only does NOT refuse staged overlap (case 5)
//   4. the fast-forward itself            -> unstaged/untracked overlap (cases 2, 3, 6)
export function landTarget(projectDir, targetBranch, sha, { log = () => {}, err = () => {} } = {}) {
  const head = runGit(["symbolic-ref", "--short", "HEAD"], projectDir, { check: false });
  const onBranch = head.code === 0 ? head.stdout.trim() : "(detached HEAD)";
  if (onBranch !== targetBranch) {
    const reason = `shared checkout is on '${onBranch}', not '${targetBranch}'`;
    err(`[land] refusing: ${reason}`);
    return { landed: false, reason, paths: [] };
  }

  if (runGit(["merge-base", "--is-ancestor", "HEAD", sha], projectDir, { check: false }).code !== 0) {
    const reason = `${sha.slice(0, 7)} is not a descendant of ${targetBranch} — not a fast-forward`;
    err(`[land] refusing: ${reason}`);
    return { landed: false, reason, paths: [] };
  }

  const changed = changedPaths(projectDir, sha);
  const staged = lines(runGit(["diff", "--cached", "--name-only", "--no-renames"], projectDir, { check: false }).stdout);
  const stagedOverlap = changed.filter((p) => staged.includes(p));
  if (stagedOverlap.length) {
    const reason = `staged changes overlap the merge: ${stagedOverlap.join(", ")}`;
    err(`[land] refusing: ${reason}`);
    return { landed: false, reason, paths: stagedOverlap };
  }

  const ff = runGit(["merge", "--ff-only", sha], projectDir, { check: false });
  if (ff.code !== 0) {
    const detail = (ff.stderr || ff.stdout).trim();
    const reason = `fast-forward refused${detail ? `: ${detail}` : ""}`;
    err(`[land] refusing: ${reason}`);
    const dirty = uncommittedPaths(projectDir);
    return { landed: false, reason, paths: changed.filter((p) => dirty.includes(p)) };
  }

  log(`[land] fast-forwarded ${targetBranch} to ${sha.slice(0, 7)}`);
  return { landed: true };
}
