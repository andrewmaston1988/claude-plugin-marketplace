// The estate scan, off the request path. `buildSnapshot` walks every run dir and
// re-parses only the ones whose key moved since the last call — the same idea as
// server.mjs's scoreCache/costCache, keyed per run instead of per file. `filterRuns`
// is the cap/expand/finishedTotals logic, unchanged from the old handler, now run
// over an in-memory snapshot instead of a fresh disk scan.
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { readRun, listRuns } from "../runlog.mjs";
import { projectGrouping } from "./grouping.mjs";

const safeStat = (p) => { try { return statSync(p); } catch { return null; } };

// (run.log mtime, size, summary.json mtime | null, manifest.json mtime | null) —
// topology() reads the manifest too, so a manifest rewrite (a resumed run's new
// snapshot) must invalidate the cache the same as a log append.
function keyOf(dir) {
  const log = safeStat(join(dir, "run.log"));
  const summary = safeStat(join(dir, "summary.json"));
  const manifest = safeStat(join(dir, "manifest.json"));
  return `${log?.mtimeMs}:${log?.size}:${summary?.mtimeMs ?? "-"}:${manifest?.mtimeMs ?? "-"}`;
}

// Pure: `cache` is a Map<dir, { key, run }> the caller owns across calls — the
// worker keeps one for its whole lifetime, tests keep one per assertion.
export function buildSnapshot(home, cache, { now = Date.now(), heartbeatMs = 15_000, quietWarnMs = 60_000, _listRuns = listRuns, _readRun = readRun } = {}) {
  const all = _listRuns(home, { now, heartbeatMs });
  // Groups derive from EVERY raw key, before any filtering — the common-prefix
  // derivation must not shift with whatever happens to survive the cap.
  const { groupOf, labelOf } = projectGrouping([...new Set(all.map((r) => r.project))]);
  const seenDirs = new Set();
  const rows = all.map((r) => {
    seenDirs.add(r.dir);
    const key = keyOf(r.dir);
    const hit = cache.get(r.dir);
    const run = hit && hit.key === key ? hit.run : _readRun(r.dir, { now, quietWarnMs, heartbeatMs });
    cache.set(r.dir, { key, run });
    const group = groupOf(r.project);
    return {
      project: r.project, name: r.name, active: r.active, aborted: r.aborted, stopped: r.stopped, mtimeMs: r.mtimeMs,
      group, groupLabel: labelOf(group),
      startedMs: run?.startedMs ?? null, finishedMs: run?.finishedMs ?? null,
      byState: run?.totals.byState ?? {}, leaves: run?.tasks.length ?? 0, waves: run?.waves.length ?? 0,
      tokens: run ? run.tasks.reduce((n, t) => n + (t.tokens ? (t.tokens.input || 0) + (t.tokens.output || 0) + (t.tokens.cacheCreation || 0) : 0), 0) : 0,
      hasDigest: !!(run?.digestPath || run?.reportPath),
    };
  });
  for (const dir of [...cache.keys()]) if (!seenDirs.has(dir)) cache.delete(dir);
  const version = createHash("sha1").update(JSON.stringify(rows)).digest("hex");
  return { rows, version };
}

// Lifted verbatim from the old /api/runs handler: the per-group finished cap, the
// expand opt-out, and finishedTotals over every row (never the capped subset).
export function filterRuns(rows, { finishedPerProject = 10, expanded = new Set() } = {}) {
  const finishedTotals = {};
  for (const r of rows) if (!r.active) finishedTotals[r.group] = (finishedTotals[r.group] || 0) + 1;
  const seen = new Map();
  const picked = rows.filter((r) => {
    if (r.active) return true;
    if (expanded.has(r.group)) return true;
    const n = seen.get(r.group) || 0;
    seen.set(r.group, n + 1);
    return n < finishedPerProject;
  });
  return { rows: picked, finishedTotals };
}
