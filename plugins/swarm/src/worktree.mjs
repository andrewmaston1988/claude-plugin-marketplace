import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60000 });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

// True when `path` is already a registered worktree of `repo` — the kept tree
// a prior failed/timed-out leaf left behind.
function isRegisteredWorktree(path, repo) {
  const list = git(["worktree", "list", "--porcelain"], repo);
  if (list.status !== 0) return false;
  const want = resolve(path);
  return list.stdout.split("\n").some((l) =>
    l.startsWith("worktree ") && resolve(l.slice("worktree ".length).trim()) === want);
}

// Create — or re-enter — an isolated worktree for an implementation leaf:
//   git worktree add <resultsDir>/wt-<id> -b <prefix><id> --no-track <HEAD of task cwd repo>
// The branch prefix comes from config — never hardcoded. On resend the leaf's
// worktree may already exist (kept on timeout for salvage): re-enter it so the
// partial diff survives and the leaf resumes in place, rather than 0s-failing on
// a re-create. `reset` (the --force redo) scrubs it back to HEAD first.
export function prepareIsolation(task, cfg, resultsDir, { reset = false } = {}) {
  const repo = task.originalCwd || task.cwd;
  const prefix = cfg.worktreeBranchPrefix || "swarm/";
  const branch = `${prefix}${task.id}`;
  const path = resolve(join(resultsDir, `wt-${task.id}`));

  const head = git(["rev-parse", "HEAD"], repo);
  if (head.status !== 0) {
    throw new Error(`cannot resolve HEAD in ${repo}: ${head.stderr || "not a git repo?"}`);
  }

  if (isRegisteredWorktree(path, repo)) {
    // A --force redo scrubs the kept partial work; a plain resend preserves it.
    if (reset) {
      git(["reset", "--hard", head.stdout], path);
      git(["clean", "-fd"], path);
    }
    return { path, branch, head: head.stdout, repo, reused: true };
  }

  let add = git(["worktree", "add", path, "-b", branch, "--no-track", head.stdout], repo);
  if (add.status !== 0 && /already exists/i.test(add.stderr)) {
    // Stale branch (path was cleaned but the branch lingered): force it to HEAD.
    add = git(["worktree", "add", path, "-B", branch, "--no-track", head.stdout], repo);
  }
  if (add.status !== 0) {
    throw new Error(`git worktree add failed for '${task.id}': ${add.stderr}`);
  }

  return { path, branch, head: head.stdout, repo, reused: false };
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
