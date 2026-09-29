// The estate scan, off the request path. `buildSnapshot` walks every run dir and
// re-parses only the ones whose key moved since the last call — the same idea as
// server.mjs's scoreCache/costCache, keyed per run instead of per file. `filterRuns`
// is the cap/expand/finishedTotals logic, unchanged from the old handler, now run
// over an in-memory snapshot instead of a fresh disk scan.
//
// `createWorkerEstate` is the other half of that: the scan is expensive enough to
// want its own thread, and the two are read together — which is why the estate and
// the worker that owns it live in one module, not split across a line count.
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { readRun, listRuns } from "../runlog.mjs";
import { runCost, costDeps } from "../run-cost.mjs";
import { workTokens } from "../stream.mjs";
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
  const deps = costDeps(home);
  const rows = all.map((r) => {
    seenDirs.add(r.dir);
    const key = keyOf(r.dir);
    const hit = cache.get(r.dir);
    const run = hit && hit.key === key ? hit.run : _readRun(r.dir, { now, quietWarnMs, heartbeatMs });
    cache.set(r.dir, { key, run });
    const group = groupOf(r.project);
    const providerTokens = {};
    const providersRunning = new Set();
    for (const task of run?.tasks || []) {
      const provider = task.provider || "unknown";
      providerTokens[provider] = (providerTokens[provider] || 0) + workTokens(task.tokens);
      if (task.state === "running") providersRunning.add(provider);
    }
    const cost = runCost(run?.tasks || [], deps);
    return {
      project: r.project, name: r.name, active: r.active, aborted: r.aborted, stopped: r.stopped, mtimeMs: r.mtimeMs,
      group, groupLabel: labelOf(group),
      startedMs: run?.startedMs ?? null, finishedMs: run?.finishedMs ?? null,
      byState: run?.totals.byState ?? {}, leaves: run?.tasks.length ?? 0, waves: run?.waves.length ?? 0,
      tokens: run ? run.tasks.reduce((n, t) => n + workTokens(t.tokens), 0) : 0,
      providers: [...new Set((run?.tasks || []).map((task) => task.provider).filter(Boolean))],
      providerTokens, providersRunning: [...providersRunning],
      hasDigest: !!(run?.digestPath || run?.reportPath),
      // Each unit priced apart and left raw: the server turns it into text under `display.money`.
      ...(Object.keys(cost).length && { cost }),
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

const ESTATE_WORKER = fileURLToPath(new URL("./estate-worker.mjs", import.meta.url));

// The default `_estate`: a worker owns buildSnapshot, restarting with backoff on
// exit (1s -> 30s cap). `current()` resolves the first snapshot once it lands, or
// after `_firstWaitMs` builds one in-thread so no request waits unboundedly.
export function createWorkerEstate({ home, pollMs, heartbeatMs, quietWarnMs, dlog, _Worker, _setTimeout, _firstWaitMs }) {
  let worker = null;
  let latest = null;
  let backoffMs = 1000;
  let backoffTimer = null;
  let closed = false;
  const listeners = new Set();
  let waiters = [];

  const notify = (snapshot) => {
    latest = snapshot;
    const ws = waiters; waiters = [];
    for (const resolve of ws) resolve(snapshot);
    for (const cb of listeners) cb(snapshot);
  };

  const spawn = () => {
    worker = new _Worker(ESTATE_WORKER, { workerData: { home, pollMs, heartbeatMs, quietWarnMs } });
    worker.on("message", (msg) => {
      if (msg?.type === "build-error") { dlog("estate-worker", { event: "build-error", msg: msg.msg }); return; }
      if (msg?.type !== "snapshot") return;
      backoffMs = 1000;
      notify({ version: msg.version, rows: msg.rows });
    });
    worker.on("error", (e) => dlog("estate-worker", { event: "error", msg: e.message }));
    worker.on("exit", (code) => {
      if (closed) return;
      dlog("estate-worker", { event: "exit", code });
      const delay = backoffMs;
      backoffMs = Math.min(30_000, backoffMs * 2);
      backoffTimer = _setTimeout(() => { backoffTimer = null; spawn(); }, delay);
    });
  };
  spawn();

  // One fallback timer for every request waiting on the first snapshot: concurrent
  // cold-start requests share a single in-thread build instead of one scan each.
  let fallbackTimer = null;
  return {
    current() {
      if (latest) return Promise.resolve(latest);
      return new Promise((resolve) => {
        waiters.push(resolve);
        if (fallbackTimer) return;
        fallbackTimer = _setTimeout(() => {
          fallbackTimer = null;
          if (latest || closed || !waiters.length) return;
          dlog("estate-worker", { event: "fallback", msg: "in-thread snapshot" });
          notify(buildSnapshot(home, new Map(), { now: Date.now(), heartbeatMs, quietWarnMs }));
        }, _firstWaitMs);
      });
    },
    refresh() { try { worker?.postMessage({ type: "refresh" }); } catch {} },
    onSnapshot(cb) { listeners.add(cb); },
    close() {
      closed = true;
      clearTimeout(backoffTimer); clearTimeout(fallbackTimer); fallbackTimer = null;
      try { worker?.terminate(); } catch {}
      // Nothing may wait on a closed estate: hand pending requests the last snapshot.
      const ws = waiters; waiters = [];
      for (const resolve of ws) resolve(latest ?? { version: "closed", rows: [] });
    },
    // An update handover closes the http server and, if the replacement fails,
    // re-listens on the SAME server — the estate must come back with it.
    reopen() { if (!closed) return; closed = false; backoffMs = 1000; spawn(); },
  };
}
