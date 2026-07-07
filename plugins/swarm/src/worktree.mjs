import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60000 });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

// Create an isolated worktree for an implementation leaf:
//   git worktree add <resultsDir>/wt-<id> -b <prefix><id> --no-track <HEAD of task cwd repo>
// The branch prefix comes from config — never hardcoded.
export function prepareIsolation(task, cfg, resultsDir) {
  const repo = task.originalCwd || task.cwd;
  const prefix = cfg.worktreeBranchPrefix || "swarm/";
  const branch = `${prefix}${task.id}`;
  const path = resolve(join(resultsDir, `wt-${task.id}`));

  const head = git(["rev-parse", "HEAD"], repo);
  if (head.status !== 0) {
    throw new Error(`cannot resolve HEAD in ${repo}: ${head.stderr || "not a git repo?"}`);
  }

  let add = git(["worktree", "add", path, "-b", branch, "--no-track", head.stdout], repo);
  if (add.status !== 0 && /already exists/i.test(add.stderr)) {
    // Re-run after a failed attempt: reset the stale branch to current HEAD.
    add = git(["worktree", "add", path, "-B", branch, "--no-track", head.stdout], repo);
  }
  if (add.status !== 0) {
    throw new Error(`git worktree add failed for '${task.id}': ${add.stderr}`);
  }

  return { path, branch, head: head.stdout, repo };
}

// Collect after the leaf ran: unchanged worktrees are removed (and their
// branches deleted — they point at the start HEAD and carry nothing); changed
// ones are kept and reported for the session to inspect/merge.
export function collect(task, cfg, wt) {
  const status = git(["status", "--porcelain"], wt.path);
  const headNow = git(["rev-parse", "HEAD"], wt.path);
  const changed = status.stdout !== "" || (headNow.status === 0 && headNow.stdout !== wt.head);

  if (!changed) {
    git(["worktree", "remove", "--force", wt.path], wt.repo);
    git(["branch", "-D", wt.branch], wt.repo);
    return { kept: false, branch: wt.branch, path: wt.path };
  }

  // Diff against the start HEAD covers both committed and uncommitted changes.
  const diffstat = git(["diff", "--stat", wt.head], wt.path);
  return {
    kept: true,
    branch: wt.branch,
    path: wt.path,
    porcelain: status.stdout,
    diffstat: diffstat.stdout,
  };
}
