import { join, resolve, dirname, sep } from "node:path";
import { unlandedCount } from "./worktree.mjs";

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
export function reposOfTrees(fs, dir, spawnSync) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(join(dir, e.name, ".git")))
    .map((e) => repoOfWorktree(spawnSync, join(dir, e.name)));
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

// `git worktree list --porcelain` parsed with the injected git, mirroring
// worktree.mjs's prepareIsolation-side registry read — duplicated rather than
// imported because that one is bound to the real spawnSync git and this seam
// must stay scriptable.
export function registeredUnder(git, repo, resultsDir) {
  const r = git(["worktree", "list", "--porcelain"], repo);
  if (r.status !== 0) return [];
  const prefix = resolve(resultsDir) + sep;
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
  return rows.filter((r) => (r.path + sep).startsWith(prefix) || r.path.startsWith(prefix));
}

// `run`: { live, repos: [string], resultsDir, worktreesKept: [{ branch, path, repo }] }.
// A run may span several repos, so every kept tree carries its OWN repo and `repos`
// is the set to sweep for orphans the summary never recorded — never one scalar,
// which attributed every tree to whichever repo resolved first.
// `live` short-circuits before any git/fs call — a live run is never inspected,
// only refused, so the cost of asking must be zero.
export function plan(run, git, fs) {
  if (run.live) return { live: true };

  const rows = [];
  const seen = new Set();
  for (const wt of run.worktreesKept || []) {
    if (!fs.existsSync(wt.path)) continue; // already gone from disk — not a row to plan or report
    rows.push(measureRow({ path: wt.path, branch: wt.branch, bytes: dirSize(fs, wt.path), repo: wt.repo }, git, fs));
    seen.add(resolve(wt.path));
  }

  for (const repo of run.repos || []) {
    if (!fs.existsSync(repo)) continue;
    for (const reg of registeredUnder(git, repo, run.resultsDir)) {
      if (seen.has(reg.path)) continue;
      // Registered but gone from disk: `git status` against a missing cwd would fail
      // closed and block the run forever, so it is not a row to measure.
      if (!fs.existsSync(reg.path)) continue;
      rows.push(measureRow({ path: reg.path, branch: reg.branch, bytes: dirSize(fs, reg.path), repo }, git, fs));
      seen.add(reg.path);
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
