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
  const baseRef = task.baseRef || "HEAD";
  const head = git(["rev-parse", baseRef], repo, { timeout: 60000 });
  if (head.status !== 0) {
    throw new Error(task.baseRef
      ? `cannot resolve base '${baseRef}' in ${repo} for task '${task.id}': ${head.stderr || "no such ref"} — ` +
        `isolation.from names a task whose branch must exist by the time this leaf runs`
      : `cannot resolve HEAD in ${repo}: ${head.stderr || "not a git repo?"}`);
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
    return {
      path, branch, name, repo, reused: true,
      head: (!reset && treeHead.status === 0) ? treeHead.stdout : head.stdout,
      ...(task.baseRef && { baseRef: task.baseRef }),
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
  // may still sit on a branch holding earlier phases' commits, and `branch -D`
  // would take them with it. `isChainFollower` only sees THIS plan's group, so
  // ask git as well — measured against the tree's own base, since a `from`-based
  // tree inherits its dependency's commits at birth.
  const repoHead = git(["rev-parse", "HEAD"], wt.repo, { timeout: 60000 });
  const base = wt.baseRef ? wt.head : repoHead.stdout;
  const carriesWork = repoHead.status !== 0 || unlandedCount(base, wt.branch, wt.repo) > 0;

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

// ---- Snapshot trees: one frozen, detached copy of a repo per run, shared by its read-only leaves.

// Ten minutes: a 60 s kill mid-checkout leaves a locked, half-populated tree. Written as a product
// because config.test.mjs forbids the bare millisecond literal under src/.
const SNAPSHOT_TIMEOUT = 10 * 60 * 1000;
// Keeps the snapshot independent of the operator's identity and signing config.
const SNAPSHOT_IDENTITY = ["-c", "user.name=swarm", "-c", "user.email=swarm@localhost", "-c", "commit.gpgsign=false"];

// 12 hex of sha1 over the resolved path: ref-safe whatever the path holds, short under a long
// Windows run home, and (unlike the encoded run-home name) collision-free.
export function snapshotKey(s) {
  const p = resolve(s);
  return createHash("sha1").update(process.platform === "win32" ? p.toLowerCase() : p).digest("hex").slice(0, 12);
}

function must(r, step, repo) {
  if (r.status !== 0) throw new Error(`cannot snapshot ${repo}: ${step} failed: ${r.stderr || r.stdout || "no output"}`);
  return r.stdout;
}

// A commit whose tree is the working tree as it stands (HEAD + uncommitted + untracked-not-ignored),
// built through a COPY of the index so the operator's index and files are untouched. A clean tree
// snapshots as HEAD itself. Pinned by refs/swarm/snapshots/<runKey>/<repoKey> so it outlives the tree.
export function snapshotCommit(repo, { resultsDir, runKey, repoKey, label, _git = git }) {
  const idx = join(resultsDir, `snapshot-${repoKey}.index`);
  const scrub = () => {
    rmSync(idx, { force: true });
    rmSync(idx + ".lock", { force: true });
  };
  const g = (args, opts = {}) => _git(args, repo, { timeout: SNAPSHOT_TIMEOUT, ...opts });
  scrub();
  try {
    const head = g(["rev-parse", "HEAD"]);
    if (head.status !== 0) {
      throw new Error(`cannot snapshot ${repo}: it has no commits yet — commit once, or give the task isolation: "worktree"`);
    }
    // --git-path is relative to the git cwd and worktree-aware (a linked worktree's .git is a file).
    const realIdx = resolve(repo, must(g(["rev-parse", "--git-path", "index"]), "rev-parse --git-path index", repo));
    // Copying (not read-tree HEAD) keeps the stat cache and skip-worktree bits.
    if (existsSync(realIdx)) copyFileSync(realIdx, idx);
    const env = { GIT_INDEX_FILE: idx };
    must(g(["add", "-A"], { env }), "add -A", repo);
    const tree = must(g(["write-tree"], { env }), "write-tree", repo);
    const headTree = must(g(["rev-parse", "HEAD^{tree}"]), "rev-parse HEAD^{tree}", repo);
    const clean = tree === headTree;
    const sha = clean
      ? head.stdout
      : must(g([...SNAPSHOT_IDENTITY, "commit-tree", tree, "-p", head.stdout, "-m", `swarm snapshot ${label}`]), "commit-tree", repo);
    must(g(["update-ref", `refs/swarm/snapshots/${runKey}/${repoKey}`, sha]), "update-ref", repo);
    return { sha, clean };
  } finally {
    scrub();
  }
}

// Remove an engine-owned snapshot tree, however it died. A timed-out `worktree add` leaves the tree
// registered and locked; `remove --force` refuses it, `remove -f -f` does not. Never throws.
// True when `path` is gone afterwards.
export function removeSnapshotTree(path, repo, { _git = git } = {}) {
  const g = (args) => _git(args, repo, { timeout: 60000 });
  try { g(["worktree", "remove", "-f", "-f", path]); } catch { /* exit is ignored */ }
  try { rmSync(path, { recursive: true, force: true }); } catch { /* held open on Windows */ }
  try { g(["worktree", "prune"]); } catch { /* best effort */ }
  return !existsSync(path);
}

// The tree's path is a pure function of run and repo (never the SHA): a resumed leaf runs
// `claude --resume`, which finds its session by cwd.
export function prepareSnapshotTree(repo, sha, resultsDir, repoKey, { _git = git } = {}) {
  const path = resolve(resultsDir, "wt-snapshot-" + repoKey);
  const g = (args, cwd, opts = {}) => _git(args, cwd, { timeout: SNAPSHOT_TIMEOUT, ...opts });

  if (g(["cat-file", "-e", `${sha}^{commit}`], repo).status !== 0) {
    throw new Error(`snapshot ${sha} no longer exists in ${repo} — its ref was pruned`);
  }
  if (isRegisteredWorktree(path, repo)) {
    const at = g(["rev-parse", "HEAD"], path);
    const dirty = g(["status", "--porcelain"], path);
    if (at.status === 0 && at.stdout === sha && dirty.status === 0 && dirty.stdout === "") return path;
    removeSnapshotTree(path, repo, { _git });
  }
  const add = g(["-c", "core.longpaths=true", "worktree", "add", "--detach", path, sha], repo,
    { env: { GIT_LFS_SKIP_SMUDGE: "1" } });
  if (add.status !== 0) {
    removeSnapshotTree(path, repo, { _git });
    throw new Error(`git worktree add of snapshot ${sha} failed in ${repo}: ${add.stderr || "timed out"}`);
  }
  return path;
}

// The leaf sits at the same depth in the tree as in the live checkout, so cwd-relative prompt paths
// still resolve. Created empty when absent (a gitignored directory is never captured).
export function snapshotCwd(tree, repoToplevel, originalCwd) {
  const rel = relative(repoToplevel, originalCwd);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
    throw new Error(`cwd ${originalCwd} is outside its repo ${repoToplevel} — a snapshot-mode task must sit inside its repoToplevel`);
  }
  const p = join(tree, rel);
  mkdirSync(p, { recursive: true });
  return p;
}
