import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

// `timeout` is required: snapshot calls pass a long one, and a silent 60 s default
// mid-checkout would leave a locked, half-populated tree. `env` merges over process.env.
function git(args, cwd, { timeout, env }) {
  const r = spawnSync("git", args, {
    cwd, encoding: "utf8", windowsHide: true, timeout,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

// Commits on `branch` not already landed on `base`, compared by PATCH (`git
// cherry`) rather than commit identity or ancestry: squash-merge — the
// documented landing path — rewrites commits, and ancestry says nothing once
// HEAD has moved sideways. Returns Infinity when git cannot answer, so callers
// FAIL CLOSED: an unresolvable question must block a destructive path, not
// waive it.
function unlandedCount(base, branch, repo) {
  const c = git(["cherry", base, branch], repo, { timeout: 60000 });
  if (c.status !== 0) return Infinity;
  return c.stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("+")).length;
}

// Maps every ref-illegal sequence to "-". expandManifest names a child's tree `<node>~<child>`,
// and `git check-ref-format` rejects "~".
function sanitiseRef(name) {
  return String(name)
    .replace(/[~^:?*[\\\s]/g, "-")
    .replace(/\.\.+/g, "-")
    .replace(/@\{/g, "-")
    .replace(/(\.lock|\.)$/, "-");
}

// The one rule for a task's branch name: an explicit `branch` wins,
// else the worktree name under the configured prefix (and the run's `branchScope`
// for a default-private tree). Exported so the scheduler resolves `from` /
// `integrate` sources the same way prepareIsolation creates them — three copies
// of this formula is how they drift apart.
export function branchNameFor(task, cfg) {
  if (task.branchName) return task.branchName;
  const name = sanitiseRef(task.worktreeName || task.id);
  return `${cfg.worktreeBranchPrefix || "swarm/"}${task.branchScope ? task.branchScope + "/" : ""}${name}`;
}

// True when `path` is already a registered worktree of `repo` — the kept tree
// a prior failed/timed-out leaf left behind.
function isRegisteredWorktree(path, repo) {
  const list = git(["worktree", "list", "--porcelain"], repo, { timeout: 60000 });
  if (list.status !== 0) return false;
  // Case-insensitive on win32: git records the case the filesystem reports, which need
  // not match the one swarm derived, and a miss here re-creates a live tree.
  const key = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const want = key(path);
  return list.stdout.split("\n").some((l) =>
    l.startsWith("worktree ") && key(l.slice("worktree ".length).trim()) === want);
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
  const head = git(["rev-parse", "HEAD"], repo, { timeout: 60000 });
  if (head.status !== 0) {
    throw new Error(`cannot resolve HEAD in ${repo}: ${head.stderr || "not a git repo?"}`);
  }

  if (isRegisteredWorktree(path, repo)) {
    // A --force redo scrubs the kept partial work; a plain resend preserves it.
    if (reset) {
      git(["reset", "--hard", head.stdout], path, { timeout: 60000 });
      git(["clean", "-fd"], path, { timeout: 60000 });
    }
    // A follower starts from what its predecessor left, so its own collect()
    // diffstat covers its work alone rather than the whole chain's.
    const treeHead = git(["rev-parse", "HEAD"], path, { timeout: 60000 });
    // Re-entering a tree adopts its ref: `branch` is only the name this task would
    // have used had it created the tree, and a tree seeded by another node is on
    // that node's ref instead.
    const on = git(["rev-parse", "--abbrev-ref", "HEAD"], path, { timeout: 60000 });
    const reused = on.status === 0 && on.stdout && on.stdout !== "HEAD" ? on.stdout : branch;
    return {
      path, branch: reused, name, repo, reused: true,
      head: (!reset && treeHead.status === 0) ? treeHead.stdout : head.stdout,
    };
  }

  let add = git(["worktree", "add", path, "-b", branch, "--no-track", head.stdout], repo, { timeout: 60000 });
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
    add = git(["worktree", "add", path, "-B", branch, "--no-track", head.stdout], repo, { timeout: 60000 });
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
// `isIntegrateSource`: true when some `integrate` node names this task's
// branch. The worktree directory still goes — nothing merges a directory —
// but the branch survives even carrying nothing, because the merge needs the
// REF, not its contents: `git merge` on an empty branch reports "Already up
// to date".
export function collect(task, cfg, wt, { isChainFollower = false, isIntegrateSource = false } = {}) {
  const status = git(["status", "--porcelain"], wt.path, { timeout: 60000 });
  const headNow = git(["rev-parse", "HEAD"], wt.path, { timeout: 60000 });
  const changed = status.stdout !== "" || (headNow.status === 0 && headNow.stdout !== wt.head);

  // Destroy only a tree that carries nothing: a leaf changing nothing of its OWN
  // may still sit on a branch holding earlier phases' commits (or an integrate node's
  // merges), and `branch -D` would take them with it. `isChainFollower` only sees THIS
  // plan's group, so ask git as well.
  const repoHead = git(["rev-parse", "HEAD"], wt.repo, { timeout: 60000 });
  const carriesWork = repoHead.status !== 0 || unlandedCount(repoHead.stdout, wt.branch, wt.repo) > 0;

  if (!changed && !(wt.reused && isChainFollower) && !carriesWork) {
    git(["worktree", "remove", "--force", wt.path], wt.repo, { timeout: 60000 });
    if (!isIntegrateSource) git(["branch", "-D", wt.branch], wt.repo, { timeout: 60000 });
    return { kept: false, branchKept: isIntegrateSource, branch: wt.branch, path: wt.path };
  }

  // Diff against the start HEAD covers both committed and uncommitted changes.
  const diffstat = git(["diff", "--stat", wt.head], wt.path, { timeout: 60000 });
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
    const m = git(["merge", "--no-edit", src], wt.path, { timeout: 60000 });
    if (m.status === 0) { merged.push(src); continue; }
    // Conflicted: keep the markers, record the paths, move on. `git merge` has
    // already staged what it could and left the rest marked.
    const conflicted = git(["diff", "--name-only", "--diff-filter=U"], wt.path, { timeout: 60000 });
    const paths = conflicted.stdout
      ? conflicted.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
    if (!paths.length) {
      // Failed for a reason other than content conflict (missing ref, unrelated
      // histories) — surface it rather than pretending it merged.
      git(["merge", "--abort"], wt.path, { timeout: 60000 });
      throw new Error(`integrate '${task.id}': cannot merge ${src}: ${m.stderr || m.stdout}`);
    }
    for (const p of paths) if (!conflicts.includes(p)) conflicts.push(p);
    merged.push(src);
  }

  return { path: wt.path, branch: wt.branch, name: wt.name, repo, merged, conflicts };
}

// ---- Run scoping and cwd depth: what survives the snapshot tree's removal.

// 12 hex of sha1 over the resolved path: ref-safe whatever the path holds, short under a long
// Windows run home, and (unlike the encoded run-home name) collision-free. Scopes a derived
// branch to its run so a kept tree from an earlier run of the same manifest cannot block it.
export function runScopeKey(s) {
  const p = resolve(s);
  return createHash("sha1").update(process.platform === "win32" ? p.toLowerCase() : p).digest("hex").slice(0, 12);
}

// The leaf sits at the same depth in its tree as in the live checkout, so cwd-relative prompt
// paths still resolve. This is every WRITER's cwd mapper, not a snapshot detail: without it a
// leaf that declared a subdirectory lands at the tree root instead.
//
// The mkdir is load-bearing for the same reason. A writer whose declared cwd is gitignored
// (build/, .claude/worktrees/x) has no such directory in the tree and cannot spawn without it.
export function treeCwd(tree, repoToplevel, originalCwd) {
  // No repo recorded means no depth to preserve, so the tree root IS the leaf's cwd. Only a
  // hand-built plan reaches this: normalisation sets repoToplevel on every writer, which is
  // what stops a real writer silently landing at its root.
  if (!repoToplevel) return tree;
  const rel = relative(repoToplevel, originalCwd);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
    throw new Error(`cwd ${originalCwd} is outside its repo ${repoToplevel} — a task with a tree must sit inside its repoToplevel`);
  }
  const p = join(tree, rel);
  mkdirSync(p, { recursive: true });
  return p;
}
