import { join, resolve, dirname } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { unlandedCount, treeDirFor, runOfTree, listTreeRecords, legacyTreeDirs } from "./worktree.mjs";
import { normalizeForCompare } from "./roots.mjs";
import { getConfig } from "./config.mjs";

// Every byte under `path`, walked with the injected `fs` — real `node:fs` in
// production, a scripted stand-in in tests. Missing/unreadable entries count as
// 0 rather than throwing: a row must still print even if part of the tree is
// already gone.
function dirSize(fs, path) {
  let entries;
  try {
    entries = fs.readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(fs, full);
    } else {
      try {
        total += fs.statSync(full).size;
      } catch {
        // gone between readdir and stat — not this function's problem
      }
    }
  }
  return total;
}

// A worktree's own `.git` file names its repo's common dir — no need for the
// run record to carry `repo` at all, so long as at least one kept tree is
// still on disk to ask.
export function repoOfWorktree(spawnSync, worktreePath) {
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: worktreePath, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  return dirname(resolve(worktreePath, (r.stdout || "").trim()));
}

// Every tree still sitting in the run dir, asked for its repo — the summary may
// have recorded none, and the manifest's cwd may be a worktree long since removed.
export function reposOfTrees(fs, dir, spawnSync, { cfg } = {}) {
  const out = [];
  // Both places a run's trees can be: its scratch dir under `treeRoot` (where the resolver
  // creates them) and the run dir itself (the pre-upgrade <run>/wt-* layout).
  for (const root of [resolve(dir), runScratchDir(dir, treeCfg(cfg))]) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(root, e.name);
      if (fs.existsSync(join(p, ".git"))) out.push(repoOfWorktree(spawnSync, p));
    }
  }
  return out;
}

// A git runner behind an injected spawnSync — the closure production code and
// tests both build over the raw module.
export function makeGit(spawnSync) {
  return (args, cwd) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60000 });
    return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
  };
}

// Every cwd the manifest named, not just the top-level one — a manifest may place
// tasks in different repos, and once every kept worktree is gone manifest.json's
// cwd (the invoking process's cwd at dispatch) is the only surviving record of them.
export function reposFromManifest(fs, dir) {
  try {
    const m = JSON.parse(fs.readFileSync(join(dir, "manifest.json"), "utf8"));
    const cwds = [m.cwd, ...(Array.isArray(m.tasks) ? m.tasks.map((t) => t?.cwd) : [])];
    return cwds.filter((c) => typeof c === "string" && c);
  } catch {
    return [];
  }
}

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

// The trees git still has registered for THIS run. Ownership is the resolver's own inverse,
// not a prefix test: a tree lives under <treeRoot>/<project>/<run> now, so "starts with
// resultsDir" stopped matching the moment creation moved — and would meanwhile sweep a
// sibling run's tree into this run's prune.
export function registeredForRun(git, repo, resultsDir, { cfg } = {}) {
  const r = git(["worktree", "list", "--porcelain"], repo);
  if (r.status !== 0) return [];
  const dir = resolve(resultsDir);
  const runsRoot = dirname(dirname(dir));
  const rows = [];
  let cur = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) rows.push(cur);
      cur = { path: resolve(line.slice("worktree ".length).trim()), branch: null };
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  if (cur) rows.push(cur);
  const key = (p) => normalizeForCompare(p);
  const want = key(dir);
  const root = treeCfg(cfg);
  return rows.filter((row) => key(runOfTree(row.path, root, { runsRoot })) === want);
}

// A tree found by scanning carries no repo or branch of its own: ask the tree. Null when
// git cannot answer, which is how a stray directory is told apart from a real worktree — a
// row prune cannot resolve is not one it may destroy.
function treeFacts(git, path) {
  const common = git(["rev-parse", "--git-common-dir"], path);
  if (common.status !== 0 || !common.stdout) return null;
  const head = git(["rev-parse", "--abbrev-ref", "HEAD"], path);
  const branch = head.status === 0 && head.stdout && head.stdout !== "HEAD" ? head.stdout : null;
  return { repo: dirname(resolve(path, common.stdout)), branch };
}

// `run`: { live, repos: [string], resultsDir, worktreesKept: [{ branch, path, repo }] }.
// A run may span several repos, so every kept tree carries its OWN repo and `repos`
// is the set to sweep for orphans the summary never recorded — never one scalar,
// which attributed every tree to whichever repo resolved first.
// `live` short-circuits before any git/fs call — a live run is never inspected,
// only refused, so the cost of asking must be zero.
export function plan(run, git, fs, { cfg } = {}) {
  if (run.live) return { live: true };

  const rows = [];
  const seen = new Set();
  // The path is kept AS GIVEN — the injected `fs` keys on it, and a summary's own
  // spelling is what the report prints. Only the dedupe key is normalised, so the three
  // sources agree about a path however each of them spelled it.
  const addRow = (path, branch, repo) => {
    const key = normalizeForCompare(path);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(measureRow({ path, branch, bytes: dirSize(fs, path), repo }, git, fs));
  };

  // summary.json's own list: how the run reported what it left, and the only source that
  // carries a shared chain's taskIds. It is not authoritative for what EXISTS — a killed
  // run wrote no summary, a summary entry can name a path already moved — so the two
  // scans below add to it rather than replacing it.
  for (const wt of run.worktreesKept || []) {
    if (!fs.existsSync(wt.path)) continue; // already gone from disk — not a row to plan or report
    addRow(wt.path, wt.branch, wt.repo);
  }

  // Everything else on disk that belongs to the run, wherever the resolver put it.
  if (run.resultsDir) {
    for (const t of heldTrees(run.resultsDir, { cfg })) {
      if (seen.has(t.path) || !fs.existsSync(t.path)) continue;
      const facts = t.repo && t.branch ? t : treeFacts(git, t.path);
      if (!facts?.repo) continue; // not a worktree git can speak for — never a row to destroy
      addRow(t.path, t.branch ?? facts.branch ?? null, facts.repo);
    }
  }

  for (const repo of run.repos || []) {
    if (!fs.existsSync(repo)) continue;
    for (const reg of registeredForRun(git, repo, run.resultsDir, { cfg })) {
      if (seen.has(reg.path)) continue;
      // Registered but gone from disk: `git status` against a missing cwd would fail
      // closed and block the run forever, so it is not a row to measure.
      if (!fs.existsSync(reg.path)) continue;
      addRow(reg.path, reg.branch, repo);
    }
  }

  return { rows };
}

// Commits a detached tree's HEAD holds that no branch or remote reaches — what
// `worktree remove` unreferences. A killed `worktree add` leaves HEAD detached at a
// commit that IS on a branch (count 0, prunes as before); an agent that kept working
// in that orphaned tree leaves commits behind that are not. `Infinity` when git
// cannot answer, the same fail-closed contract as `unlandedCount`.
function detachedUnlanded(git, path) {
  const r = git(["rev-list", "--count", "HEAD", "--not", "--branches", "--remotes"], path);
  if (r.status !== 0) return Infinity;
  const n = Number.parseInt(r.stdout, 10);
  return Number.isFinite(n) ? n : Infinity;
}

function measureRow(row, git, fs) {
  if (!fs.existsSync(row.repo)) return { ...row, unlanded: Infinity, dirty: Infinity };
  const unlanded = row.branch
    ? unlandedCount("HEAD", row.branch, row.repo, git)
    : detachedUnlanded(git, row.path);
  const status = git(["status", "--porcelain", "--untracked-files=all"], row.path);
  const dirty = status.status === 0
    ? status.stdout.split(/\r?\n/).filter(Boolean).length
    : Infinity;
  return { ...row, unlanded, dirty };
}

export function blockers(rows) {
  return rows.filter((row) => !Number.isFinite(row.unlanded) || row.unlanded > 0 || !Number.isFinite(row.dirty) || row.dirty > 0);
}

// Destroy in order: the worktree directory, then the branch it sat on — a row
// whose repo is gone skips git entirely and is just removed from disk.
export function execute(rows, git, fs) {
  for (const row of rows) {
    if (!fs.existsSync(row.repo)) {
      fs.rmSync(row.path, { recursive: true, force: true });
      continue;
    }
    // A detached tree has no branch, and may be left locked by a killed `worktree add`.
    if (row.branch) {
      git(["worktree", "remove", "--force", row.path], row.repo);
      git(["branch", "-D", row.branch], row.repo);
    } else {
      git(["worktree", "remove", "-f", "-f", row.path], row.repo);
    }
  }
}

function gb(bytes) {
  return (bytes / 1024 ** 3).toFixed(2);
}

// The one place the work cells are spelled: the table lays them out and the refusal
// repeats them, so a second copy of these strings in the command layer is how the
// report and the reason it was refused drift apart.
export function workCounts(row) {
  const counts = [];
  if (row.unlanded > 0) counts.push(`${Number.isFinite(row.unlanded) ? row.unlanded : "unmeasurable"} unlanded`);
  if (row.dirty > 0) counts.push(`${Number.isFinite(row.dirty) ? row.dirty : "unmeasurable"} uncommitted`);
  return counts;
}

export function formatPrune(rows, { dryRun = false } = {}) {
  const lines = rows.map((r) => {
    let line = `  ${r.path}  ${gb(r.bytes)} GB  ${r.branch ?? "(detached)"}`;
    for (const cell of workCounts(r)) line += `  ${cell}`;
    return line;
  });
  const total = rows.reduce((s, r) => s + r.bytes, 0);
  const verb = dryRun ? "would free" : "freed";
  lines.push(`${verb} ${gb(total)} GB across ${rows.length} worktree${rows.length === 1 ? "" : "s"}`);
  return lines.join("\n");
}
