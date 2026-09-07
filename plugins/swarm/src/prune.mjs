import { join, resolve, sep } from "node:path";

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

// `run`: { live, repo, resultsDir, worktreesKept: [{ branch, path, repo? }] }.
// `live` short-circuits before any git/fs call — a live run is never inspected,
// only refused, so the cost of asking must be zero.
export function plan(run, git, fs) {
  if (run.live) return { live: true };

  const rows = [];
  const seen = new Set();
  for (const wt of run.worktreesKept || []) {
    const repo = wt.repo || run.repo;
    rows.push({ path: wt.path, branch: wt.branch, bytes: dirSize(fs, wt.path), repo });
    seen.add(resolve(wt.path));
  }

  if (fs.existsSync(run.repo)) {
    for (const reg of registeredUnder(git, run.repo, run.resultsDir)) {
      if (seen.has(reg.path)) continue;
      rows.push({ path: reg.path, branch: reg.branch, bytes: dirSize(fs, reg.path), repo: run.repo });
      seen.add(reg.path);
    }
  }

  return { rows };
}

// Destroy in order: the worktree directory, then the branch it sat on — a row
// whose repo is gone skips git entirely and is just removed from disk.
export function execute(rows, git, fs) {
  for (const row of rows) {
    if (!fs.existsSync(row.repo)) {
      fs.rmSync(row.path, { recursive: true, force: true });
      continue;
    }
    git(["worktree", "remove", "--force", row.path], row.repo);
    git(["branch", "-D", row.branch], row.repo);
  }
}

function gb(bytes) {
  return (bytes / 1024 ** 3).toFixed(2);
}

export function formatPrune(rows, { dryRun = false } = {}) {
  const lines = rows.map((r) => `  ${r.path}  ${gb(r.bytes)} GB  ${r.branch}`);
  const total = rows.reduce((s, r) => s + r.bytes, 0);
  const verb = dryRun ? "would free" : "freed";
  lines.push(`${verb} ${gb(total)} GB across ${rows.length} worktree${rows.length === 1 ? "" : "s"}`);
  return lines.join("\n");
}
