import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { swarmHome } from "./config.mjs";
import { isUnderRoot } from "./roots.mjs";

export const WORKTREE_ADD_TIMEOUT_MS = 180000;

// `timeout` is required: snapshot calls pass a long one, and a silent timeout
// mid-checkout would leave a locked, half-populated tree. `env` merges over process.env.
function git(args, cwd, { timeout, env }) {
  const r = spawnSync("git", args, {
    cwd, encoding: "utf8", windowsHide: true, timeout,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), timedOut: r.error?.code === "ETIMEDOUT" };
}

// Commits on `branch` not already landed on `base`, compared by PATCH (`git
// cherry`) rather than commit identity or ancestry: squash-merge — the
// documented landing path — rewrites commits, and ancestry says nothing once
// HEAD has moved sideways. Returns Infinity when git cannot answer, so callers
// FAIL CLOSED: an unresolvable question must block a destructive path, not
// waive it.
export function unlandedCount(base, branch, repo, gitRunner = git) {
  const c = gitRunner(["cherry", base, branch], repo, { timeout: 60000 });
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

// ---- Where a run's trees live: one scratch root, one resolver, one record.
//
// A run dir holds RESULTS. Its leaf trees are scratch — rebuildable, large, and
// safe to delete on their own — so they live under a separate root:
//   <treeRoot>/<encoded-project>/<run>/<name>
// Same encoded-project/run naming as the runs root, so a tree path still says
// which run owns it. Nothing may derive a tree path a second way: the five other
// derivations that used to exist disagreed the moment either end moved.

// The scratch root: `treeRoot` when set, else <swarmHome>/worktrees. Both the
// resolver and the consumers that only need the root (governance, discovery) call
// this rather than recomputing it.
export function treeRootFor(cfg, { env = process.env } = {}) {
  return resolve(cfg?.treeRoot || join(swarmHome(env), "worktrees"));
}

// The <encoded-project>/<run> tail a tree path is built from, read off the END of
// resultsDir so the formula holds whatever the runs root is.
function runTail(resultsDir) {
  const dir = resolve(resultsDir);
  return [basename(dirname(dir)), basename(dir)];
}

// The ONE place a tree path is built, resolving in order — each step exists for a
// case the next one gets wrong:
//   (a) the run's own record for `name`, which is authoritative and is the only
//       thing that survives a legacy tree, a reconfigured `treeRoot`, or a tree an
//       operator relocated;
//   (b) a legacy <run>/wt-<name> git still has registered — resuming a pre-upgrade
//       run after the upgrade would otherwise compute the new path, and
//       `worktree add -b` would fail with "branch already used by worktree" while
//       the write-guard root pointed at a tree that does not exist;
//   (c) the formula.
// `repo` is needed for (b), which only git can answer; without it (b) is skipped.
export function treeDirFor(resultsDir, name, cfg, { repo, env = process.env } = {}) {
  const recorded = readTreeRecord(resultsDir, name);
  if (recorded?.path) return resolve(recorded.path);
  const legacy = legacyTreeDirFor(resultsDir, name);
  if (repo && isRegisteredWorktree(legacy, repo)) return legacy;
  return resolve(join(treeRootFor(cfg, { env }), ...runTail(resultsDir), String(name)));
}

// treeDirFor's inverse, for every site that recovers a run from a tree path. A tree
// under `treeRoot` is <project>/<run>/<name>, so its run dir is
// <runsRoot>/<project>/<run>; anything else is a legacy tree sitting IN its run dir,
// so the tree's own parent is the answer.
//
// `runsRoot` defaults to <swarmHome>/runs, which is the only root the formula ever
// writes into. Pass `runsRootFor(resultsDir)` when the caller holds a run dir of its
// OWN in that root — the run whose tree is holding a branch is a sibling of it, and
// taking the root from the caller makes the inverse exact whatever the root is.
export function runOfTree(path, cfg, { env = process.env, runsRoot } = {}) {
  const p = resolve(path);
  const root = treeRootFor(cfg, { env });
  if (isUnderRoot(p, root)) {
    const rel = relative(root, p);
    const parts = !isAbsolute(rel) && !rel.startsWith("..") ? rel.split(sep) : [];
    if (parts.length >= 3) {
      return resolve(join(runsRoot ? resolve(runsRoot) : join(swarmHome(env), "runs"), parts[0], parts[1]));
    }
  }
  return resolve(dirname(p));
}

// The runs root `resultsDir` sits in — the one whose two-level tail IS resultsDir.
// The same assumption runTail() makes, read from the other side, so a caller that
// knows one run dir in the root can hand the root to runOfTree and get its siblings
// back exactly.
function runsRootFor(resultsDir) {
  const dir = resolve(resultsDir);
  return dirname(dirname(dir));
}

// A run's own record of where it put one tree: <run>/trees/<name>.json. ONE FILE
// PER TREE, never a shared index — an index is a read-modify-write race between the
// writer leaves of one engine, and a single `.tmp` collides when they land together.
export function treeRecordPath(resultsDir, name) {
  return join(resolve(resultsDir), "trees", `${String(name)}.json`);
}

// The record for `name`, or null when there is none (or it is unreadable — a
// half-written file is a tree about to be recorded, not a reason to fail).
export function readTreeRecord(resultsDir, name) {
  try {
    const rec = JSON.parse(readFileSync(treeRecordPath(resultsDir, name), "utf8"));
    return rec !== null && typeof rec === "object" && !Array.isArray(rec) ? rec : null;
  } catch { return null; }
}

// Every tree this run recorded. Discovery unions this with the `treeRoot` scan and
// the legacy scan; a malformed record is skipped rather than thrown, so one bad
// file cannot take the whole discovery down.
export function listTreeRecords(resultsDir) {
  let names;
  try { names = readdirSync(join(resolve(resultsDir), "trees")); } catch { return []; }
  const out = [];
  for (const n of names) {
    // `.json.tmp` is a write in flight; anything else in here is not a record.
    if (!n.endsWith(".json")) continue;
    const rec = readTreeRecord(resultsDir, n.slice(0, -".json".length));
    if (rec) out.push(rec);
  }
  return out;
}

const LEGACY_TREE_PREFIX = "wt-";

// The single-name legacy location. Private: callers that want a legacy tree ask the
// resolver, which knows whether git still has it registered.
function legacyTreeDirFor(resultsDir, name) {
  return resolve(join(resultsDir, `${LEGACY_TREE_PREFIX}${name}`));
}

// The pre-upgrade trees a run left in its own dir: <run>/wt-<name>. Discovery needs
// all of them, not just the ones a name resolves to.
export function legacyTreeDirs(resultsDir) {
  const dir = resolve(resultsDir);
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith(LEGACY_TREE_PREFIX) && e.name.length > LEGACY_TREE_PREFIX.length)
    .map((e) => ({ name: e.name.slice(LEGACY_TREE_PREFIX.length), path: join(dir, e.name) }));
}

// Atomic (`.tmp` + rename) so no reader ever sees a half-written record. The
// `.tmp` is per-tree, which is what makes two concurrent leaves safe.
function writeTreeRecord(resultsDir, record) {
  const path = treeRecordPath(resultsDir, record.name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", JSON.stringify(record, null, 2) + "\n");
  renameSync(path + ".tmp", path);
  return path;
}

// Drop a tree's record with the tree. A record left saying "ready" for a swept
// path is a tree that discovery would try to remove a second time.
function removeTreeRecord(resultsDir, name) {
  try { rmSync(treeRecordPath(resultsDir, name), { force: true }); } catch { /* best effort */ }
}

// Create — or re-enter — an isolated worktree for an implementation leaf:
//   git worktree add <treeDirFor(…)> -b <prefix><name> --no-track <base>
// The branch prefix comes from config — never hardcoded. On resend the leaf's
// worktree may already exist (kept on timeout for salvage): re-enter it so the
// partial diff survives and the leaf resumes in place, rather than 0s-failing on
// a re-create. `reset` (the --force redo) scrubs it back to the base first.
//
// `base` is REQUIRED — the run's pinned dispatch commit for this repo (run-bases.mjs),
// never a live HEAD read; defaulting it is how a caller silently keeps the old behaviour.
export function prepareIsolation(task, cfg, resultsDir, { reset = false, addTimeoutMs, base } = {}) {
  if (!(Number.isFinite(addTimeoutMs) && addTimeoutMs > 0)) throw new Error("prepareIsolation requires a positive addTimeoutMs");
  if (typeof base !== "string" || !base.trim()) {
    throw new Error("prepareIsolation requires the run's pinned base commit — reading the live HEAD here would cut the tree from a commit the run never saw");
  }
  const repo = task.originalCwd || task.cwd;
  // Ordered siblings sharing a name meet in one tree; without one, the task's
  // own id names a private tree.
  const name = task.worktreeName || task.id;
  const branch = branchNameFor(task, cfg);
  const path = treeDirFor(resultsDir, name, cfg, { repo });

  if (isRegisteredWorktree(path, repo)) {
    // A --force redo scrubs the kept partial work; a plain resend preserves it.
    if (reset) {
      git(["reset", "--hard", base], path, { timeout: 60000 });
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
    // Re-entering a tree the run has no record of (one kept by an earlier run, or a
    // legacy <run>/wt-<name>) is how the run ADOPTS it: from here on the record is
    // what resolves this name, whatever `treeRoot` is set to next.
    writeTreeRecord(resultsDir, { name, path, branch: reused, repo, state: "ready" });
    return {
      path, branch: reused, name, repo, resultsDir, reused: true,
      head: (!reset && treeHead.status === 0) ? treeHead.stdout : base,
    };
  }

  // Write-ahead, BEFORE the add: a crash between the two then leaves a record prune
  // can resolve, never a tree on disk that no one knows about. `state: "creating"`
  // means the add may or may not have finished — consumers must tolerate a path
  // that is not there.
  writeTreeRecord(resultsDir, { name, path, branch, repo, state: "creating" });

  let add = git(["worktree", "add", path, "-b", branch, "--no-track", base], repo, { timeout: addTimeoutMs });
  if (add.status !== 0 && /already exists/i.test(add.stderr)) {
    // Stale branch (path was cleaned but the branch lingered): force it to the base.
    // But -B RESETS the branch, so refuse when it still carries unlanded work.
    // "Unlanded" is measured against the LIVE tip — the base is only where this
    // run's trees start, and squashing onto it would hide work already merged on.
    const tip = repoHead(repo);
    const unlanded = tip ? unlandedCount(tip, branch, repo) : Infinity;
    if (unlanded > 0 && !reset) {
      throw new Error(
        `worktree branch '${branch}' carries ${unlanded === Infinity ? "an unknown number of" : unlanded} unlanded commit(s) — refusing to reset it ` +
        `for task '${task.id}'. That work came from an earlier run and would be lost.\n` +
        `    inspect:  git log ${branch}\n` +
        `    reuse it: name a different worktree, merge/delete '${branch}' yourself, or re-run with --force`);
    }
    add = git(["worktree", "add", path, "-B", branch, "--no-track", base], repo, { timeout: addTimeoutMs });
  }
  if (add.status !== 0) {
    // A branch live in another worktree is not a retryable add failure: the message
    // git gives names the tree, and nothing else does. A run that re-enters a kept
    // tree from an earlier run (or two runs of one manifest sharing a branch) lands
    // here, and the raw "already used by worktree" reads as corruption.
    if (/already (used by|checked out at) worktree/i.test(add.stderr)) {
      const holder = add.stderr.match(/worktree at '([^']+)'/)?.[1];
      // The holder is the TREE; `swarm prune` takes the RUN dir that holds it, and
      // the tree path fails with "no run at … (no run.log)". A tree under `treeRoot`
      // is no longer the run dir's child, so the run dir has to be resolved — and
      // the holder belongs to a sibling of OUR run, which is where the root comes
      // from. Printed the way git printed the holder: one path style in one message.
      const runDir = holder ? runOfTree(holder, cfg, { runsRoot: runsRootFor(resultsDir) }).replaceAll("\\", "/") : null;
      throw new Error(
        `branch '${branch}' is checked out in another worktree${holder ? ` (${holder})` : ""} — ` +
        `finish or prune that run (swarm prune ${runDir || "…"}), or name a different branch/workspace`);
    }
    if (add.timedOut) {
      throw new Error(`git worktree add timed out after ${addTimeoutMs / 1000}s for '${task.id}' — a slow repo hook (post-checkout / reference-transaction) is the usual cause: ${add.stderr}`);
    }
    throw new Error(`git worktree add failed for '${task.id}': ${add.stderr}`);
  }

  writeTreeRecord(resultsDir, { name, path, branch, repo, state: "ready" });
  // `resultsDir` rides along so collect() can drop the record with the tree without
  // deriving the run dir back out of a path that now lives somewhere else entirely.
  return { path, branch, name, head: base, repo, resultsDir, reused: false };
}

// The live HEAD of `repo`'s checkout — the commit a run PINS at dispatch
// (run-bases.mjs) and the tip `unlandedCount` measures against. Null outside git.
export function repoHead(repo) {
  const r = git(["rev-parse", "HEAD"], repo, { timeout: 60000 });
  return r.status === 0 && r.stdout ? r.stdout : null;
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
    // The record goes with the tree: a record still saying "ready" would name a path
    // that discovery would then try to remove all over again.
    if (wt.resultsDir) removeTreeRecord(wt.resultsDir, wt.name);
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
    uncommitted: measureUncommitted(wt),
  };
}

// What the leaf left outside git history. `--untracked-files=all` so a new directory
// counts its files, not one path. Commits ahead is a plain rev-list count, not
// `unlandedCount`'s patch cherry, which answers Infinity when git fails.
function measureUncommitted(wt) {
  const dirty = git(["status", "--porcelain", "--untracked-files=all"], wt.path, { timeout: 60000 });
  const ahead = git(["rev-list", "--count", `${wt.head}..HEAD`], wt.path, { timeout: 60000 });
  // null, not 0: a status git could not answer must never read as a clean tree.
  const files = dirty.status === 0 ? dirty.stdout.split(/\r?\n/).filter(Boolean).length : null;
  return { files, commitsAhead: ahead.status === 0 ? Number(ahead.stdout) || 0 : 0 };
}

// Fold sibling branches into one tree so a later leaf can carry on from the
// combined state. Deliberately NOT atomic: a conflicted merge is left in the
// tree with its markers, because the next link is a model that can read them
// and resolve. Failing the node instead would turn an ordinary conflict — the
// thing merges do — into a dead run needing operator rescue.
//
// The node owns the target tree: it creates it (or re-enters a kept one) rather
// than borrowing a tree a leaf is using, so nothing races.
export function integrate(task, cfg, resultsDir, { repo: repoOverride, base } = {}) {
  const repo = repoOverride || task.originalCwd || task.cwd;
  const wt = prepareIsolation({ ...task, originalCwd: repo }, cfg, resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base });

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

// The checkout containing `cwd` — a linked worktree answers with itself — or null outside
// git. A writer's tree is cut from this checkout's HEAD, so its depth is measured from here.
export function checkoutToplevel(cwd) {
  const r = git(["rev-parse", "--show-toplevel"], cwd, { timeout: 60000 });
  return r.status === 0 && r.stdout ? r.stdout : null;
}

// The leaf sits at the same depth in its tree as in the live checkout, so cwd-relative prompt
// paths still resolve. This is every WRITER's cwd mapper, not a snapshot detail: without it a
// leaf that declared a subdirectory lands at the tree root instead.
//
// The mkdir is load-bearing for the same reason. A writer whose declared cwd is gitignored
// (build/, .claude/worktrees/x) has no such directory in the tree and cannot spawn without it.
export function treeCwd(tree, checkoutToplevel, originalCwd) {
  // No repo recorded means no depth to preserve, so the tree root IS the leaf's cwd. Only a
  // hand-built plan reaches this: normalisation sets checkoutToplevel on every writer, which is
  // what stops a real writer silently landing at its root.
  if (!checkoutToplevel) return tree;
  const rel = relative(checkoutToplevel, originalCwd);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
    throw new Error(`cwd ${originalCwd} is outside its repo ${checkoutToplevel} — a task with a tree must sit inside its checkoutToplevel`);
  }
  const p = join(tree, rel);
  mkdirSync(p, { recursive: true });
  return p;
}
