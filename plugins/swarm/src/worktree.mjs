import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60000 });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

// Commits on `branch` not already landed on `base`, compared by PATCH (`git
// cherry`) rather than commit identity or ancestry: squash-merge — the
// documented landing path — rewrites commits, and ancestry says nothing once
// HEAD has moved sideways. Returns Infinity when git cannot answer, so callers
// FAIL CLOSED: an unresolvable question must block a destructive path, not
// waive it.
function unlandedCount(base, branch, repo) {
  const c = git(["cherry", base, branch], repo);
  if (c.status !== 0) return Infinity;
  return c.stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("+")).length;
}

// The one rule for a task's branch name: an explicit `isolation.branch` wins,
// else the worktree name under the configured prefix. Exported so the scheduler
// resolves `from` / `integrate` sources the same way prepareIsolation creates
// them — three copies of this formula is how they drift apart.
export function branchNameFor(task, cfg) {
  const name = task.worktreeName || task.id;
  return task.branchName || `${cfg.worktreeBranchPrefix || "swarm/"}${name}`;
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
  // Ordered siblings sharing a name meet in one tree; without one, the task's
  // own id names a private tree.
  const name = task.worktreeName || task.id;
  const branch = branchNameFor(task, cfg);
  const path = resolve(join(resultsDir, `wt-${name}`));

  // A leaf that builds on another's committed work bases its tree on that
  // branch instead of repo HEAD — otherwise it starts without the code it
  // depends on. `wt.head` follows the base, so "did this leaf change anything"
  // stays a question about THIS leaf's work.
  const baseRef = task.baseRef || "HEAD";
  const head = git(["rev-parse", baseRef], repo);
  if (head.status !== 0) {
    throw new Error(task.baseRef
      ? `cannot resolve base '${baseRef}' in ${repo} for task '${task.id}': ${head.stderr || "no such ref"} — ` +
        `isolation.from names a task whose branch must exist by the time this leaf runs`
      : `cannot resolve HEAD in ${repo}: ${head.stderr || "not a git repo?"}`);
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
      ...(task.baseRef && { baseRef: task.baseRef }),
    };
  }

  let add = git(["worktree", "add", path, "-b", branch, "--no-track", head.stdout], repo);
  if (add.status !== 0 && /already exists/i.test(add.stderr)) {
    // Stale branch (path was cleaned but the branch lingered): force it to HEAD.
    // But -B RESETS the branch, so refuse when it still carries unlanded work.
    const unlanded = unlandedCount(head.stdout, branch, repo);
    if (unlanded > 0 && !reset) {
      throw new Error(
        `worktree branch '${branch}' carries ${unlanded === Infinity ? "an unknown number of" : unlanded} unlanded commit(s) — refusing to reset it ` +
        `for task '${task.id}'. That work came from an earlier run and would be lost.\n` +
        `    inspect:  git log ${branch}\n` +
        `    reuse it: name a different worktree, merge/delete '${branch}' yourself, or re-run with --force`);
    }
    add = git(["worktree", "add", path, "-B", branch, "--no-track", head.stdout], repo);
  }
  if (add.status !== 0) {
    throw new Error(`git worktree add failed for '${task.id}': ${add.stderr}`);
  }

  return { path, branch, name, head: head.stdout, repo, reused: false, ...(task.baseRef && { baseRef: task.baseRef }) };
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

  // Destroy only a tree that carries nothing: a leaf changing nothing of its OWN
  // may still sit on a branch holding earlier phases' commits, and `branch -D`
  // would take them with it. `isChainFollower` only sees THIS plan's group, so
  // ask git as well — measured against the tree's own base, since a `from`-based
  // tree inherits its dependency's commits at birth.
  const repoHead = git(["rev-parse", "HEAD"], wt.repo);
  const base = wt.baseRef ? wt.head : repoHead.stdout;
  const carriesWork = repoHead.status !== 0 || unlandedCount(base, wt.branch, wt.repo) > 0;

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

// Fold sibling branches into one tree so a later leaf can carry on from the
// combined state. Deliberately NOT atomic: a conflicted merge is left in the
// tree with its markers, because the next link is a model that can read them
// and resolve. Failing the node instead would turn an ordinary conflict — the
// thing merges do — into a dead run needing operator rescue.
//
// The node owns the target tree: it creates it (or re-enters a kept one) rather
// than borrowing a tree a leaf is using, so nothing races.
export function integrate(task, cfg, resultsDir, { repo: repoOverride } = {}) {
  const repo = repoOverride || task.originalCwd || task.cwd;
  const wt = prepareIsolation({ ...task, originalCwd: repo }, cfg, resultsDir);

  const merged = [];
  const conflicts = [];
  for (const src of task.sources || []) {
    const m = git(["merge", "--no-edit", src], wt.path);
    if (m.status === 0) { merged.push(src); continue; }
    // Conflicted: keep the markers, record the paths, move on. `git merge` has
    // already staged what it could and left the rest marked.
    const conflicted = git(["diff", "--name-only", "--diff-filter=U"], wt.path);
    const paths = conflicted.stdout
      ? conflicted.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
    if (!paths.length) {
      // Failed for a reason other than content conflict (missing ref, unrelated
      // histories) — surface it rather than pretending it merged.
      git(["merge", "--abort"], wt.path);
      throw new Error(`integrate '${task.id}': cannot merge ${src}: ${m.stderr || m.stdout}`);
    }
    for (const p of paths) if (!conflicts.includes(p)) conflicts.push(p);
    merged.push(src);
  }

  return { path: wt.path, branch: wt.branch, name: wt.name, repo, merged, conflicts };
}
