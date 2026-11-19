// What a finished run still holds on disk: its tree records, its scratch dir, git's
// registrations and its own branches. Split out of prune.mjs, which measures and
// destroys what this finds. Every name is re-exported from prune.mjs, so the public
// surface and every existing call site stay unchanged.
import { dirname, join, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { getConfig } from "./config.mjs";
import { normalizeForCompare } from "./roots.mjs";
import { legacyTreeDirs, listTreeRecords, runOfTree, runScopeKey, treeDirFor } from "./worktree.mjs";

// The config the tree root is read from. A caller that already holds one passes it; the
// CLI's prune path does not, and a hardcoded default here would go blind the moment an
// operator points `treeRoot` at another drive. A malformed config degrades to the default
// rather than failing a read-only listing.
export function treeCfg(cfg) {
  if (cfg) return cfg;
  try { return getConfig(); } catch { return null; }
}

// The dir a run's trees live in — <treeRoot>/<encoded-project>/<run>. Asked of the
// resolver rather than spelled again: `\0` is a name no filesystem accepts and no record
// can carry, so treeDirFor takes its formula branch and the one path rule stays in
// worktree.mjs.
const NO_TREE_NAME = "\u0000";
export function runScratchDir(resultsDir, cfg) {
  return resolve(dirname(treeDirFor(resultsDir, NO_TREE_NAME, cfg)));
}

// Every tree a run still holds on disk: the ones its own per-tree records name, whatever
// sits in its scratch dir that no record names (a killed `worktree add`, a lost record),
// and the pre-upgrade <run>/wt-* trees the run dir still carries. prune and the nudge both
// ask this one function — a second copy of the union is how the nudge ends up naming a run
// whose prune listing is empty, or the reverse.
export function heldTrees(resultsDir, { cfg } = {}) {
  const dir = resolve(resultsDir);
  const byPath = new Map();
  const add = (path, name, extra = {}) => {
    if (!path) return;
    const p = resolve(path);
    if (!byPath.has(p)) byPath.set(p, { name: name ?? null, path: p, branch: null, repo: null, ...extra });
  };
  for (const rec of listTreeRecords(dir)) add(rec.path, rec.name, { branch: rec.branch ?? null, repo: rec.repo ?? null });
  // The scratch dir holds nothing but trees, so no name filter applies there.
  for (const p of subdirs(runScratchDir(dir, treeCfg(cfg)))) add(p, null);
  for (const t of legacyTreeDirs(dir)) add(t.path, t.name);
  // A record or a stray dir naming a tree that is already gone is not a tree to report.
  return [...byPath.values()].filter((t) => existsSync(t.path));
}

function subdirs(dir) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
}

// The one parser for `git worktree list --porcelain` — `head` is what a missing detached
// tree has left to measure. Null when git cannot answer.
export function worktreeList(git, repo) {
  const r = git(["worktree", "list", "--porcelain"], repo);
  if (r.status !== 0) return null;
  const rows = [];
  let cur = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) rows.push(cur);
      cur = { path: resolve(line.slice("worktree ".length).trim()), branch: null, head: null };
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (cur && line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length).trim();
    }
  }
  if (cur) rows.push(cur);
  return rows;
}

// The trees git still has registered for THIS run. Ownership is the resolver's own inverse,
// not a prefix test: a tree lives under <treeRoot>/<project>/<run> now, so "starts with
// resultsDir" stopped matching the moment creation moved — and would meanwhile sweep a
// sibling run's tree into this run's prune.
export function registeredForRun(git, repo, resultsDir, { cfg } = {}) {
  const rows = worktreeList(git, repo);
  if (!rows) return [];
  const dir = resolve(resultsDir);
  const runsRoot = dirname(dirname(dir));
  const key = (p) => normalizeForCompare(p);
  const want = key(dir);
  const root = treeCfg(cfg);
  return rows.filter((row) => key(runOfTree(row.path, root, { runsRoot })) === want);
}

// A tree found by scanning carries no repo or branch of its own: ask the tree. Null when
// git cannot answer, which is how a stray directory is told apart from a real worktree — a
// row prune cannot resolve is not one it may destroy.
export function treeFacts(git, path) {
  const common = git(["rev-parse", "--git-common-dir"], path);
  if (common.status !== 0 || !common.stdout) return null;
  const head = git(["rev-parse", "--abbrev-ref", "HEAD"], path);
  const branch = head.status === 0 && head.stdout && head.stdout !== "HEAD" ? head.stdout : null;
  return { repo: dirname(resolve(path, common.stdout)), branch };
}

// Every lane a run still holds: its summary's own list, its per-tree records and scratch
// dir, git's registrations, and the run's own branches no tree holds. Lazy, so a caller
// with a spent deadline stops without paying for the rest. `orphan` marks a lane the
// summary named whose tree is gone — a record can still name it, prune has no row to
// destroy. prune and the port nudge ask this one generator, so the two can never disagree
// about which lanes a run holds.
export function* discoveredLanes(run, git, fs, { cfg } = {}) {
  const prefix = cfg?.worktreeBranchPrefix || "swarm/";
  const trees = new Set();
  const lanes = new Set();
  const laneKey = (repo, branch) => `${normalizeForCompare(repo)}\n${branch}`;
  const freshTree = (path) => {
    const key = normalizeForCompare(path);
    if (trees.has(key)) return false;
    trees.add(key);
    return true;
  };
  // An orphan names no tree, so it does not claim its branch: the run-scope scan still
  // has to find that branch and yield it as a row of its own.
  const lane = (over) => {
    if (!over.orphan && over.repo && over.branch) lanes.add(laneKey(over.repo, over.branch));
    return { path: null, branch: null, repo: null, missing: false, head: null, orphan: false, ...over };
  };
  // summary.json's own list: how the run reported what it left, and the only source that
  // carries a shared chain's taskIds. It is not authoritative for what EXISTS — a killed
  // run wrote no summary, a summary entry can name a path already moved — so the two
  // scans below add to it rather than replacing it.
  for (const wt of run.worktreesKept || []) {
    const onDisk = fs.existsSync(wt.path);
    if (onDisk && !freshTree(wt.path)) continue;
    yield lane({ path: onDisk ? wt.path : null, branch: wt.branch ?? null, repo: wt.repo ?? null, orphan: !onDisk });
  }
  // Everything else on disk that belongs to the run, wherever the resolver put it.
  if (run.resultsDir) {
    for (const t of heldTrees(run.resultsDir, { cfg })) {
      if (!fs.existsSync(t.path) || !freshTree(t.path)) continue;
      const facts = t.repo && t.branch ? t : treeFacts(git, t.path);
      if (!facts?.repo) continue; // not a worktree git can speak for — never a row to destroy
      yield lane({ path: t.path, branch: t.branch ?? facts.branch ?? null, repo: facts.repo });
    }
  }
  for (const repo of run.repos || []) {
    if (!fs.existsSync(repo)) continue;
    for (const reg of registeredForRun(git, repo, run.resultsDir, { cfg })) {
      if (!freshTree(reg.path)) continue;
      // Registered but gone from disk: a missing directory holds no uncommitted work,
      // and its registration must go before `branch -D` can take the branch.
      yield lane({ path: reg.path, branch: reg.branch, repo, missing: !fs.existsSync(reg.path), head: reg.head });
    }
  }
  // The run's OWN branches, whether or not a tree still holds one. An explicitly named
  // `branch` has no scope key and is never found here: its name can be any branch at all.
  if (run.resultsDir) {
    const scope = `refs/heads/${prefix}${runScopeKey(run.resultsDir)}/`;
    for (const repo of run.repos || []) {
      if (!fs.existsSync(repo)) continue;
      const listed = git(["for-each-ref", "--format=%(refname:short)", scope], repo);
      if (listed.status !== 0) continue;
      // A branch a tree holds is either already a tree lane or checked out somewhere
      // prune does not own; `branch -D` would refuse it either way.
      const held = new Set((worktreeList(git, repo) || []).map((t) => t.branch).filter(Boolean));
      for (const branch of listed.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
        if (held.has(branch) || lanes.has(laneKey(repo, branch))) continue;
        yield lane({ branch, repo });
      }
    }
  }
}
