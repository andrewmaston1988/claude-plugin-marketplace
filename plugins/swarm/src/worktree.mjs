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
  // The branch is normally derived from the tree name, but a run continuing work
  // onto an existing branch needs to name it — the two are separate identities.
  const branch = task.branchName || `${prefix}${name}`;
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
    // But -B RESETS the branch, so first ask whether it carries anything HEAD
    // doesn't already have — a previous run's phases live exactly there. Count,
    // not ancestry: HEAD may have moved sideways since, which says nothing about
    // whether this branch holds work.
    const carried = git(["rev-list", "--count", branch, `^${head.stdout}`], repo);
    if (carried.status === 0 && carried.stdout !== "" && carried.stdout !== "0") {
      throw new Error(
        `worktree branch '${branch}' carries ${carried.stdout} commit(s) not in HEAD — refusing to reset it ` +
        `for task '${task.id}'. That work came from an earlier run and would be lost.\n` +
        `    inspect:  git log ${branch}\n` +
        `    reuse it: name a different worktree, or merge/delete '${branch}' yourself first`);
    }
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
// `isChainFollower`: true only when this task shares its worktree with other
// chain members (group size > 1) AND the tree was reused. A resumed SOLO task
// also gets `wt.reused: true` on re-entry, but it has no predecessor commits to
// protect — an unchanged solo resend must still be swept, same as before chains
// existed.
export function collect(task, cfg, wt, { isChainFollower = false } = {}) {
  const status = git(["status", "--porcelain"], wt.path);
  const headNow = git(["rev-parse", "HEAD"], wt.path);
  const changed = status.stdout !== "" || (headNow.status === 0 && headNow.stdout !== wt.head);

  // Destroy only a tree this leaf started fresh, OR an unchanged solo resend.
  // A reused CHAIN tree's branch carries its predecessors' commits, and
  // `wt.head` is the tree's own HEAD — so a final link that changed nothing of
  // its OWN still reads as unchanged here, and deleting the branch would take
  // the whole chain's work with it. A reused SOLO tree has no such history to
  // protect.
  // `isChainFollower` only knows about THIS plan's group. A tree reused across
  // manifests, or a chain whose successor is the sole member of its own group,
  // reads as a solo resend — and deleting the branch would take every earlier
  // phase's commits with it. Ask git instead of the plan: does this branch carry
  // anything not already in the repo's HEAD? Direction-agnostic, so it stays
  // correct when HEAD has moved sideways since the tree was made.
  const repoHead = git(["rev-parse", "HEAD"], wt.repo);
  const unmerged = repoHead.status === 0
    ? git(["rev-list", "--count", wt.branch, `^${repoHead.stdout}`], wt.repo)
    : { status: 1, stdout: "" };
  const carriesWork = unmerged.status === 0 && unmerged.stdout !== "" && unmerged.stdout !== "0";

  if (!changed && !(wt.reused && isChainFollower) && !carriesWork) {
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
