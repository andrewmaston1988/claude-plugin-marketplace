import { join, resolve, dirname } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { unlandedCount, isSwarmRef } from "./landed.mjs";
import { treeDirFor, runOfTree, listTreeRecords, legacyTreeDirs, treeRecordPath, treeRootFor, runScopeKey } from "./worktree.mjs";
import { isUnderRoot, normalizeForCompare } from "./roots.mjs";
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
// tests both build over the raw module. `input` feeds a path list on stdin.
export function makeGit(spawnSync) {
  return (args, cwd, { input } = {}) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60000, input });
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

// One builder for the `run` object `plan()` measures, shared by the CLI and the port nudge
// so the two can never disagree about which trees a run holds. The missing-run and liveness
// checks stay with each caller: the CLI has messages for them, the nudge only builds
// finished runs. Returns `{ run, summary, hadSummary }`, or `{ error }` when the run names
// no repo or its summary will not parse.
export function runForPrune(dir, { fs, spawnSync }) {
  const target = resolve(dir);
  const summaryFile = join(target, "summary.json");
  const hadSummary = fs.existsSync(summaryFile);
  let summary = null;
  if (hadSummary) {
    try { summary = JSON.parse(fs.readFileSync(summaryFile, "utf8")); }
    catch (e) { return { error: `could not read ${summaryFile}: ${e.message}` }; }
  }
  const worktreesKept = Array.isArray(summary?.worktreesKept) ? summary.worktreesKept : [];
  // Resolve each tree's own repo: one scalar attributed a second repo's tree to the
  // first and `git worktree remove` then silently failed against the wrong cwd.
  const keptWithRepo = worktreesKept.map((wt) => ({ ...wt, repo: wt.repo || repoOfWorktree(spawnSync, wt.path) }));
  const repos = [...new Set([...keptWithRepo.map((wt) => wt.repo), ...reposFromManifest(fs, target), ...reposOfTrees(fs, target, spawnSync)].filter(Boolean))];
  if (!repos.length) {
    return { error: `could not resolve the repo for ${target} — no kept worktree survives and manifest.json has no cwd.` };
  }
  return { run: { live: false, repos, resultsDir: target, worktreesKept: keptWithRepo }, summary, hadSummary };
}

// The HEAD of the checkout `prune` was invoked from, as an extra landing base. Only a
// checkout that belongs to one of the run's repos and sits on a named branch outside
// the swarm prefix qualifies: a leaf worktree's own HEAD is a swarm branch, and
// absorbing against it would free the very branch being decided.
export function checkoutBase(git, path, repos, prefix) {
  const common = git(["rev-parse", "--git-common-dir"], path);
  if (common.status !== 0 || !common.stdout) return null;
  const repo = dirname(resolve(path, common.stdout));
  const same = (r) => typeof r === "string" && normalizeForCompare(r) === normalizeForCompare(repo);
  if (!repos.some(same)) return null;
  const head = git(["symbolic-ref", "-q", "HEAD"], path);
  if (head.status !== 0 || !head.stdout || isSwarmRef(head.stdout, prefix)) return null;
  const sha = git(["rev-parse", "HEAD"], path);
  if (sha.status !== 0 || !sha.stdout) return null;
  return sha.stdout;
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
// `deadline` (epoch ms, Infinity for none) and `stopAtBlocker` exist to bound a caller
// that only needs a verdict, not a full report: a stopped plan returns `stopped: true`
// and must be read as unmeasured, never as an empty or partial result.
export function plan(run, git, fs, { cfg, extraBases, measureBytes, stopAtBlocker, deadline } = {}) {
  if (!Array.isArray(extraBases)) throw new TypeError("plan requires an extraBases array");
  if (typeof measureBytes !== "boolean") throw new TypeError("plan requires measureBytes");
  if (typeof stopAtBlocker !== "boolean") throw new TypeError("plan requires stopAtBlocker");
  if (typeof deadline !== "number") throw new TypeError("plan requires a deadline");
  if (run.live) return { live: true };

  const prefix = cfg?.worktreeBranchPrefix || "swarm/";
  const rows = [];
  const seen = new Set();
  const seenBranches = new Set();
  let stopped = false;
  // A row's clock and stop budget belong to the caller, not to the shape of the row:
  // a branch-only row must honour exactly what a tree row does.
  const beginRow = () => {
    if (stopped) return false;
    if (Date.now() >= deadline) { stopped = true; return false; }
    return true;
  };
  const finishRow = (row) => {
    rows.push(row);
    if (stopAtBlocker && blockers([row]).length) stopped = true;
  };
  // The path is kept AS GIVEN — the injected `fs` keys on it, and a summary's own
  // spelling is what the report prints. Only the dedupe key is normalised, so the three
  // sources agree about a path however each of them spelled it.
  const addRow = (path, branch, repo, { missing = false, head = null } = {}) => {
    if (!beginRow()) return;
    const key = normalizeForCompare(path);
    if (seen.has(key)) return;
    seen.add(key);
    // A missing directory holds no bytes to measure.
    const bytes = measureBytes ? (missing ? 0 : dirSize(fs, path)) : null;
    finishRow(measureRow({ path, branch, bytes, repo, ...(missing && { missing: true, ...(head && { head }) }) }, git, fs, prefix, extraBases));
  };
  // Deduped on repo + branch, never on a path: there is none.
  const addBranchRow = (branch, repo) => {
    if (!beginRow()) return;
    const key = `${normalizeForCompare(repo)}\n${branch}`;
    if (seenBranches.has(key)) return;
    seenBranches.add(key);
    finishRow({
      path: null, branch, repo,
      bytes: measureBytes ? 0 : null,
      dirty: 0,
      unlanded: unlandedCount(branch, repo, { prefix, gitRunner: git, extraBases }),
    });
  };

  // summary.json's own list: how the run reported what it left, and the only source that
  // carries a shared chain's taskIds. It is not authoritative for what EXISTS — a killed
  // run wrote no summary, a summary entry can name a path already moved — so the two
  // scans below add to it rather than replacing it.
  for (const wt of run.worktreesKept || []) {
    if (stopped) break;
    if (!fs.existsSync(wt.path)) continue; // already gone from disk — not a row to plan or report
    addRow(wt.path, wt.branch, wt.repo);
  }

  // Everything else on disk that belongs to the run, wherever the resolver put it.
  if (run.resultsDir) {
    for (const t of heldTrees(run.resultsDir, { cfg })) {
      if (stopped) break;
      if (seen.has(t.path) || !fs.existsSync(t.path)) continue;
      const facts = t.repo && t.branch ? t : treeFacts(git, t.path);
      if (!facts?.repo) continue; // not a worktree git can speak for — never a row to destroy
      addRow(t.path, t.branch ?? facts.branch ?? null, facts.repo);
    }
  }

  for (const repo of run.repos || []) {
    if (stopped) break;
    if (!fs.existsSync(repo)) continue;
    for (const reg of registeredForRun(git, repo, run.resultsDir, { cfg })) {
      if (stopped) break;
      if (seen.has(reg.path)) continue;
      // Registered but gone from disk: a missing directory holds no uncommitted work,
      // and its registration must go before `branch -D` can take the branch.
      addRow(reg.path, reg.branch, repo, { missing: !fs.existsSync(reg.path), head: reg.head });
    }
  }

  // The run's OWN branches, whether or not a tree still holds one. An explicitly named
  // `branch` has no scope key and is never found here: its name can be any branch at all.
  if (run.resultsDir) {
    const scope = `refs/heads/${prefix}${runScopeKey(run.resultsDir)}/`;
    for (const repo of run.repos || []) {
      if (stopped) break;
      if (!fs.existsSync(repo)) continue;
      const listed = git(["for-each-ref", "--format=%(refname:short)", scope], repo);
      if (listed.status !== 0) continue;
      // A branch a tree holds is either already a tree row or checked out somewhere
      // prune does not own; `branch -D` would refuse it either way.
      const held = new Set((worktreeList(git, repo) || []).map((t) => t.branch).filter(Boolean));
      for (const branch of listed.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
        if (stopped) break;
        if (held.has(branch) || rows.some((row) => row.branch === branch)) continue;
        addBranchRow(branch, repo);
      }
    }
  }

  return stopped ? { rows, stopped: true } : { rows };
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

// The same question for a tree whose directory is gone: its porcelain HEAD sha is the
// only handle left, and it is asked in the repo because there is no tree to stand in.
function headUnlanded(git, repo, head) {
  if (!head) return Infinity;
  const r = git(["rev-list", "--count", head, "--not", "--branches", "--remotes"], repo);
  if (r.status !== 0) return Infinity;
  const n = Number.parseInt(r.stdout, 10);
  return Number.isFinite(n) ? n : Infinity;
}

function measureRow(row, git, fs, prefix, extraBases) {
  if (!fs.existsSync(row.repo)) return { ...row, unlanded: Infinity, dirty: Infinity };
  if (row.missing) {
    const unlanded = row.branch
      ? unlandedCount(row.branch, row.repo, { prefix, gitRunner: git, extraBases })
      : headUnlanded(git, row.repo, row.head);
    return { ...row, unlanded, dirty: 0 };
  }
  const unlanded = row.branch
    ? unlandedCount(row.branch, row.repo, { prefix, gitRunner: git, extraBases })
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
// whose repo is gone skips git entirely and is just removed from disk. Returns the
// rows git refused with its own words, so a caller reports what happened, not what
// it asked for.
export function execute(rows, git, fs, { resultsDir, cfg } = {}) {
  const records = resultsDir ? listTreeRecords(resultsDir) : [];
  const failed = [];
  const fail = (row, r) => failed.push({ row, reason: r.stderr || r.stdout || `git exited ${r.status}` });
  for (const row of rows) {
    // A branch-only row has nothing on disk: its repo's own ref is the whole row.
    if (row.path == null) {
      if (!fs.existsSync(row.repo)) continue;
      const del = git(["branch", "-D", row.branch], row.repo);
      if (del.status !== 0) fail(row, del);
      continue;
    }
    if (!fs.existsSync(row.repo)) {
      fs.rmSync(row.path, { recursive: true, force: true });
    } else if (row.missing) {
      // A missing tree may be locked by a killed `worktree add`; only -f -f removes one.
      const rm = git(["worktree", "remove", "-f", "-f", row.path], row.repo);
      // A tree git kept still holds the branch; asking for it adds only a second error.
      if (rm.status !== 0) { fail(row, rm); continue; }
      if (row.branch) {
        const del = git(["branch", "-D", row.branch], row.repo);
        if (del.status !== 0) fail(row, del);
      }
    } else {
      // A detached tree has no branch, and may be left locked by a killed `worktree add`.
      if (row.branch) {
        const rm = git(["worktree", "remove", "--force", row.path], row.repo);
        if (rm.status !== 0) { fail(row, rm); continue; }
        const del = git(["branch", "-D", row.branch], row.repo);
        if (del.status !== 0) fail(row, del);
      } else {
        const rm = git(["worktree", "remove", "-f", "-f", row.path], row.repo);
        if (rm.status !== 0) fail(row, rm);
      }
    }
    if (resultsDir && !fs.existsSync(row.path)) {
      for (const record of records) {
        if (normalizeForCompare(record.path) === normalizeForCompare(row.path)) {
          fs.rmSync(treeRecordPath(resultsDir, record.name), { force: true });
        }
      }
    }
  }
  if (resultsDir) removeEmptyTreeParents(resultsDir, cfg, fs);
  return { failed };
}

function removeEmptyTreeParents(resultsDir, cfg, fs) {
  const root = resolve(treeRootFor(cfg));
  const runDir = runScratchDir(resultsDir, cfg);
  if (runDir === root || !isUnderRoot(runDir, root)) return;
  try { fs.rmdirSync(runDir); } catch { return; }
  const projectDir = dirname(runDir);
  if (projectDir !== root && isUnderRoot(projectDir, root)) {
    try { fs.rmdirSync(projectDir); } catch { /* non-empty parents belong to their remaining trees */ }
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
    let line = `  ${r.path ?? "(no tree)"}  ${gb(r.bytes ?? 0)} GB  ${r.branch ?? "(detached)"}`;
    for (const cell of workCounts(r)) line += `  ${cell}`;
    return line;
  });
  const total = rows.reduce((s, r) => s + (r.bytes ?? 0), 0);
  const trees = rows.filter((r) => r.path != null).length;
  const branches = rows.length - trees;
  // A path-less row frees no bytes, so counting it as a worktree would misreport both.
  const treeWord = `${trees} worktree${trees === 1 ? "" : "s"}`;
  const what = branches ? `${treeWord} and ${branches} branch${branches === 1 ? "" : "es"}` : treeWord;
  const verb = dryRun ? "would free" : "freed";
  lines.push(`${verb} ${gb(total)} GB across ${what}`);
  return lines.join("\n");
}
