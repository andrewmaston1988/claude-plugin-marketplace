import { join, resolve, dirname, basename } from "node:path";
import { unlandedCount, isSwarmRef, defaultCommits } from "./landed.mjs";
import { takenKey, takenVerdict } from "./taken.mjs";
import { listTreeRecords, treeRecordPath, treeRootFor } from "./worktree.mjs";
import { isUnderRoot, normalizeForCompare } from "./roots.mjs";
import { discoveredLanes, isWorktreeRoot, repoFromRecords, runScratchDir, treeCfg } from "./prune-discover.mjs";

// Discovery moved to prune-discover.mjs; re-exported so every existing import of these
// names from prune.mjs keeps working.
export {
  discoveredLanes, entryCount, heldTrees, isUnlinked, isWorktreeRoot, registeredForRun,
  repoFromRecords, runScratchDir, treeCfg, treeFacts, worktreeLink, worktreeList,
} from "./prune-discover.mjs";

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

// The repo a kept tree belongs to. `repoOfWorktree` asks git INSIDE the directory, and a
// tree that lost its `.git` link makes that walk up to whichever repo encloses it — in the
// field the repo that tracks ~/.swarm, whose files then read as the row's own work. Only a
// confirmed worktree root may answer; anything else comes from the run's own records.
function repoForKeptTree(git, spawnSync, resultsDir, wt, fs) {
  if (wt.path && isWorktreeRoot(git, wt.path)) return repoOfWorktree(spawnSync, wt.path);
  return repoFromRecords(resultsDir, wt.name ?? basename(wt.path ?? ""), fs);
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
  const git = makeGit(spawnSync);
  const keptWithRepo = worktreesKept.map((wt) => ({ ...wt, repo: wt.repo || repoForKeptTree(git, spawnSync, target, wt, fs) }));
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

// `run`: { live, repos: [string], resultsDir, worktreesKept: [{ branch, path, repo }] }.
// A run may span several repos, so every kept tree carries its OWN repo and `repos`
// is the set to sweep for orphans the summary never recorded — never one scalar,
// which attributed every tree to whichever repo resolved first.
// `live` short-circuits before any git/fs call — a live run is never inspected,
// only refused, so the cost of asking must be zero.
// `deadline` (epoch ms, Infinity for none) and `stopAtBlocker` exist to bound a caller
// that only needs a verdict, not a full report: a stopped plan returns `stopped: true`
// and must be read as unmeasured, never as an empty or partial result.
// `taken` (a `readTaken` map, or null) settles a lane whose commits were ported into a
// feature branch that has since landed: content checks cannot see that, the recorded proof
// can. Consulted only where the content checks already said unlanded, so a clean row costs
// no extra git call.
export function plan(run, git, fs, { cfg, extraBases, measureBytes, stopAtBlocker, deadline, taken } = {}) {
  if (!Array.isArray(extraBases)) throw new TypeError("plan requires an extraBases array");
  if (typeof measureBytes !== "boolean") throw new TypeError("plan requires measureBytes");
  if (typeof stopAtBlocker !== "boolean") throw new TypeError("plan requires stopAtBlocker");
  if (typeof deadline !== "number") throw new TypeError("plan requires a deadline");
  if (!(taken instanceof Map) && taken !== null) throw new TypeError("plan requires a taken map or null");
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
  const runName = taken && run.resultsDir ? basename(resolve(run.resultsDir)) : null;
  // The default branch is invariant per repo and a multi-lane run asks once per taken row.
  const defaultBases = new Map();
  const basesFor = (repo) => {
    const key = normalizeForCompare(repo);
    if (!defaultBases.has(key)) defaultBases.set(key, defaultCommits(repo, git));
    return defaultBases.get(key);
  };
  const applyTaken = (row) => {
    if (!runName || !row.branch || !(row.unlanded > 0)) return row;
    const record = taken.get(takenKey({ run: runName, repo: row.repo, branch: row.branch }));
    if (!record) return row;
    const tip = git(["rev-parse", "--verify", `${row.branch}^{commit}`], row.repo);
    const laneTip = tip.status === 0 && tip.stdout ? tip.stdout : null;
    const verdict = takenVerdict({ record, laneTip, repo: row.repo, gitRunner: git, bases: basesFor(row.repo) });
    // `taken` rides on a kept row too: the CLI prints why it could not be proved.
    return { ...row, ...(verdict.landed && { unlanded: 0 }), taken: verdict.reason };
  };
  const finishRow = (row) => {
    const measured = applyTaken(row);
    rows.push(measured);
    if (stopAtBlocker && blockers([measured]).length) stopped = true;
  };
  // The path is kept AS GIVEN — the injected `fs` keys on it, and a summary's own
  // spelling is what the report prints. Only the dedupe key is normalised, so the three
  // sources agree about a path however each of them spelled it.
  const addRow = (path, branch, repo, { missing = false, head = null, unlinked = false, entries = 0 } = {}) => {
    if (!beginRow()) return;
    const key = normalizeForCompare(path);
    if (seen.has(key)) return;
    seen.add(key);
    // A missing directory holds no bytes to measure.
    const bytes = measureBytes ? (missing ? 0 : dirSize(fs, path)) : null;
    finishRow(measureRow({
      path, branch, bytes, repo,
      ...(missing && { missing: true, ...(head && { head }) }),
      ...(unlinked && { unlinked: true, entries }),
    }, git, fs, prefix, extraBases));
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

  // Every lane the run still holds, wherever the resolver put it.
  for (const found of discoveredLanes(run, git, fs, { cfg })) {
    if (stopped) break;
    if (found.path) {
      addRow(found.path, found.branch, found.repo, {
        ...(found.missing && { missing: true, ...(found.head && { head: found.head }) }),
        ...(found.unlinked && { unlinked: true, entries: found.entries }),
      });
    } else if (!found.orphan && found.branch && found.repo) {
      addBranchRow(found.branch, found.repo);
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

// Whether a branch still exists: `show-ref --verify` exiting 1 is positive evidence it is
// gone, which is how a deleted branch stops reading as "unmeasurable". Any other failure
// fails closed — a lookup that could not run proves nothing.
function branchState(git, repo, branch) {
  const r = git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo);
  if (r.status === 0) return "present";
  if (r.status === 1) return "absent";
  return "unknown";
}

function measureRow(row, git, fs, prefix, extraBases) {
  if (row.unlinked) {
    // Never ask git about this directory: it is not a worktree, and a cwd inside it walks
    // up to whichever repo encloses it. Measure the branch in the repo the run recorded.
    if (!row.repo) return { ...row, unlanded: Infinity, dirty: Infinity };
    const state = row.branch ? branchState(git, row.repo, row.branch) : "none";
    const unlanded = state === "present"
      ? unlandedCount(row.branch, row.repo, { prefix, gitRunner: git, extraBases })
      : state === "unknown" ? Infinity : 0;
    return { ...row, unlanded, dirty: 0 };
  }
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
  return rows.filter((row) =>
    !Number.isFinite(row.unlanded) || row.unlanded > 0 || !Number.isFinite(row.dirty) || row.dirty > 0
    // An unlinked directory's contents are nobody's to delete: git cannot say what they
    // are, so the operator decides. Held back even under --discard-unlanded.
    || (row.unlinked && row.entries > 0));
}

// Clearing a leftover directory that is no longer a worktree: drop git's stale registration
// (only `worktree prune` can, and `branch -D` refuses while it stands), remove the directory
// — NON-recursively, so a file that appeared since the plan survives instead of being
// destroyed unmeasured — then the branch, but only once git confirms it exists.
function clearUnlinked(row, git, fs) {
  const failed = [];
  const fail = (reason) => failed.push({ row, reason });
  if (fs.existsSync(row.repo)) {
    const pruned = git(["worktree", "prune"], row.repo);
    if (pruned.status !== 0) fail(pruned.stderr || pruned.stdout || `git exited ${pruned.status}`);
  }
  try {
    fs.rmdirSync(row.path, { force: true });
  } catch {
    // The directory holds something: it is not this row's to delete after all.
    fail(`${row.path} is not an empty directory`);
    return failed;
  }
  if (!row.branch || !fs.existsSync(row.repo)) return failed;
  const state = branchState(git, row.repo, row.branch);
  // A branch that is already gone is the expected half-finished prune; one whose state
  // could not be read proves nothing, so it is reported rather than forced.
  if (state === "absent") return failed;
  if (state === "unknown") { fail(`could not read the state of branch ${row.branch}`); return failed; }
  const del = git(["branch", "-D", row.branch], row.repo);
  if (del.status !== 0) fail(del.stderr || del.stdout || `git exited ${del.status}`);
  return failed;
}

// Destroy in order: the worktree directory, then the branch it sat on — a row
// whose repo is gone skips git entirely and is just removed from disk. Returns the
// rows git refused with its own words, so a caller reports what happened, not what
// it asked for.
export function execute(rows, git, fs, { resultsDir, cfg } = {}) {
  const records = resultsDir ? listTreeRecords(resultsDir) : [];
  const failed = [];
  const fail = (row, r) => failed.push({ row, reason: r.stderr || r.stdout || `git exited ${r.status}` });
  // A tree record naming a path now gone records nothing.
  const dropRecord = (path) => {
    if (!resultsDir || fs.existsSync(path)) return;
    for (const record of records) {
      if (normalizeForCompare(record.path) === normalizeForCompare(path)) {
        fs.rmSync(treeRecordPath(resultsDir, record.name), { force: true });
      }
    }
  };
  for (const row of rows) {
    if (row.path != null && row.unlinked) {
      failed.push(...clearUnlinked(row, git, fs));
      dropRecord(row.path);
      continue;
    }
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
    dropRecord(row.path);
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
