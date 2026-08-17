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
//   git worktree add <resultsDir>/wt-<name> -b <prefix><name> --no-track <HEAD of task cwd repo>
// The branch prefix comes from config — never hardcoded. On resend the leaf's
// worktree may already exist (kept on timeout for salvage): re-enter it so the
// partial diff survives and the leaf resumes in place, rather than 0s-failing on
// a re-create. `reset` (the --force redo) scrubs it back to HEAD first.
export function prepareIsolation(task, cfg, resultsDir, { reset = false } = {}) {
  const repo = task.originalCwd || task.cwd;
  const prefix = cfg.worktreeBranchPrefix || "swarm/";
  // Ordered siblings sharing a name meet in one tree; without one, the task's
  // own id names a private tree.
  const name = task.worktreeName || task.id;
  const branch = `${prefix}${name}`;
  const path = resolve(join(resultsDir, `wt-${name}`));

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
    // A follower starts from what its predecessor left, so its own collect()
    // diffstat covers its work alone rather than the whole chain's.
    const treeHead = git(["rev-parse", "HEAD"], path);
    return {
      path, branch, name, repo, reused: true,
      head: (!reset && treeHead.status === 0) ? treeHead.stdout : head.stdout,
    };
  }

  let add = git(["worktree", "add", path, "-b", branch, "--no-track", head.stdout], repo);
  if (add.status !== 0 && /already exists/i.test(add.stderr)) {
    // Stale branch (path was cleaned but the branch lingered): force it to HEAD.
    add = git(["worktree", "add", path, "-B", branch, "--no-track", head.stdout], repo);
  }
  if (add.status !== 0) {
    throw new Error(`git worktree add failed for '${task.id}': ${add.stderr}`);
  }

  return { path, branch, name, head: head.stdout, repo, reused: false };
}

// Collect after the leaf ran: unchanged worktrees are removed (and their
// branches deleted — they point at the start HEAD and carry nothing); changed
// ones are kept and reported for the session to inspect/merge.
export function collect(task, cfg, wt) {
  const status = git(["status", "--porcelain"], wt.path);
  const headNow = git(["rev-parse", "HEAD"], wt.path);
  const changed = status.stdout !== "" || (headNow.status === 0 && headNow.stdout !== wt.head);

  // Destroy only a tree this leaf started fresh. A reused tree's branch carries
  // its predecessors' commits, and `wt.head` is the tree's own HEAD — so a final
  // link that changed nothing of its OWN still reads as unchanged here, and
  // deleting the branch would take the whole chain's work with it.
  if (!changed && !wt.reused) {
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
