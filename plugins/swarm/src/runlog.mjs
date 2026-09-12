// One reader for a run's on-disk records. run.log is the truth for state; the
// manifest snapshot supplies the graph; summary.json says when it finished.
// Pure data out — the roster, the statusline glyph and the dashboard all render
// from this, so none of them carries its own parser.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { DIGEST_ID } from "./digest.mjs";
import { readHeartbeat } from "./results.mjs";

const CLONE_RE = /^(.+)\[(\d+)\]$/;

// Non-terminal, non-doomed: a leaf waiting out a backoff or model fallback. Lives here
// rather than in the scheduler because it is state vocabulary, and two modules read it.
export const ALIVE_STATES = new Set(["pending", "running", "retrying"]);

// Does a `results/<id>.json` on disk belong to a PREVIOUS attempt? readRunLog clears
// per-leaf state on every run-start, so `state` is always this attempt's — and a leaf
// that has not settled in this attempt cannot have written the file sitting there.
//
// `undefined` — no row in this attempt's roster at all — is superseded by construction.
// A forEach clone joins the roster ONLY through the log's `expand` event and is never in
// manifest.tasks, so topology() cannot backfill it: an expansion that contracts on resume
// (3 items, then 2) leaves `fix[2].json` on disk with nothing to match it.
//
// Asking "is it unsettled" rather than "is it settled" is deliberate. The settled
// vocabulary includes compound states reached only through a variable (`failed:timeout`,
// scheduler.mjs:1038), and a whitelist that missed one would HIDE a real result — the
// worse failure of the two.
//
// Deliberately not an mtime comparison: a touch (restore, copy, AV scan) would mark a
// finished result superseded permanently, which is what summarySuperseded's own comment
// warns against and what the #240 review removed one level up.
export function resultSuperseded(state) {
  return state === undefined || ALIVE_STATES.has(state);
}

// Parse run.log text into per-task rows in roster order. `now` stands in for a
// missing timestamp (pre-ts logs) and anchors quietMs.
export function readRunLog(content, { now = Date.now() } = {}) {
  let roster = [];
  let startedMs = null;
  let enginePid = null;
  let ask = null;
  const state = new Map();
  const tokens = new Map();
  const durations = new Map();
  const runningSince = new Map();
  const activity = new Map();
  const lastEvent = new Map();
  const clones = new Map();   // parent -> count
  const children = new Map(); // node -> [ids]
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // torn tail write mid-run
    }
    if (!entry || typeof entry !== "object") continue; // `null` parses; it is not an event
    if (entry.event === "run-start") {
      // pre-token logs recorded plain id strings
      roster = (entry.tasks || []).map((t) => (typeof t === "string" ? { id: t, model: "?" } : t));
      startedMs = Date.parse(entry.ts) || now;
      enginePid = Number.isInteger(entry.pid) ? entry.pid : null;
      ask = typeof entry.ask === "string" ? entry.ask : null;
      state.clear(); tokens.clear(); durations.clear(); runningSince.clear();
      activity.clear(); lastEvent.clear(); clones.clear(); children.clear();
      continue;
    }
    if (entry.event === "expand") {
      // forEach clones join the roster directly under their parent
      const rows = Array.from({ length: entry.clones || 0 }, (_, i) => ({ id: `${entry.id}[${i}]`, model: entry.model || "?" }));
      const idx = roster.findIndex((r) => r.id === entry.id);
      roster.splice(idx < 0 ? roster.length : idx + 1, 0, ...rows);
      clones.set(entry.id, entry.clones || 0);
      continue;
    }
    if (entry.event === "expand-manifest") {
      // spliced child tasks join under their node, each with its own model
      const rows = (entry.children || []).map((c) => ({ id: c.id, model: c.model || "?" }));
      const idx = roster.findIndex((r) => r.id === entry.id);
      roster.splice(idx < 0 ? roster.length : idx + 1, 0, ...rows);
      children.set(entry.id, rows.map((r) => r.id));
      continue;
    }
    if (!entry.id) continue;
    lastEvent.set(entry.id, Date.parse(entry.ts) || now);
    if (entry.event === "tokens") {
      tokens.set(entry.id, entry.tokens);
    } else if (entry.event === "activity") {
      activity.set(entry.id, entry.activity);
    } else if (entry.state) {
      state.set(entry.id, entry.state);
      if (entry.state === "running") runningSince.set(entry.id, Date.parse(entry.ts) || now);
      if (entry.durationMs != null) durations.set(entry.id, entry.durationMs);
      if (entry.tokens) tokens.set(entry.id, entry.tokens);
    }
  }
  const tasks = roster.map(({ id, model }) => {
    const st = state.get(id) || "pending";
    const last = lastEvent.get(id);
    return {
      id, model,
      state: st,
      durationMs: durations.get(id),
      startedMs: runningSince.get(id),
      tokens: tokens.get(id),
      activity: activity.get(id),
      lastEventMs: last,
      quietMs: st === "running" && last != null ? now - last : null,
    };
  });
  return { startedMs, enginePid, ask, tasks };
}

// Graph annotations from the manifest snapshot: after / kind / parent / depth,
// plus the wave grouping. Rows the log never mentioned (agentless nodes, a leaf
// that never started) are appended as pending so the graph is whole.
export function topology(tasks, manifest) {
  const defs = new Map();
  for (const t of manifest?.tasks || []) defs.set(t.id, t);
  const rows = tasks.map((t) => ({ ...t }));
  const present = new Set(rows.map((r) => r.id));
  for (const [id, d] of defs) {
    if (!present.has(id)) rows.push({ id, model: d.model || "", state: "pending", after: undefined });
  }
  const kindOf = (d) => (d.forEach ? "forEach" : d.child ? "manifest" : d.compute || d.integrate || !d.model ? "agentless" : "leaf");
  for (const r of rows) {
    const clone = CLONE_RE.exec(r.id);
    const tilde = r.id.indexOf("~");
    if (r.id === DIGEST_ID) {
      r.kind = "digest";
      r.parent = null;
      r.after = rows.filter((x) => x.id !== DIGEST_ID).map((x) => x.id);
    } else if (clone && defs.has(clone[1])) {
      r.kind = "clone";
      r.parent = clone[1];
      r.after = [...(defs.get(clone[1]).after || [])];
    } else if (tilde > 0) {
      const node = r.id.slice(0, tilde);
      const childId = r.id.slice(tilde + 1);
      const nodeDef = defs.get(node);
      const childDef = (nodeDef?.child || []).find((c) => c.id === childId);
      r.kind = "child";
      r.parent = node;
      r.after = childDef?.after?.length ? childDef.after.map((a) => `${node}~${a}`) : [...(nodeDef?.after || [])];
    } else {
      const d = defs.get(r.id);
      r.kind = d ? kindOf(d) : "leaf";
      r.parent = null;
      r.after = [...(d?.after || [])];
    }
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const depth = new Map();
  const visiting = new Set();
  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0; // cycle guard — the back-edge contributes nothing
    visiting.add(id);
    const r = byId.get(id);
    let d = 0;
    for (const a of r?.after || []) if (byId.has(a)) d = Math.max(d, depthOf(a) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const r of rows) r.depth = depthOf(r.id);
  const waves = [];
  for (const r of rows) (waves[r.depth] ||= []).push(r.id);
  return { tasks: rows, waves: waves.map((w) => w || []) };
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

// -> null when the dir has no run.log (not started, or not a run dir).
export function readRun(dir, { now = Date.now(), quietWarnMs = 60_000, heartbeatMs = 15_000 } = {}) {
  dir = resolve(dir);
  const logPath = join(dir, "run.log");
  if (!existsSync(logPath)) return null;
  const { startedMs, enginePid, ask, tasks: logged } = readRunLog(readFileSync(logPath, "utf8"), { now });
  const manifest = readJson(join(dir, "manifest.json"));
  const { tasks, waves } = topology(logged, manifest);
  const { finishedMs, stoppedMs, abortedMs } = runLiveness(dir, { now, heartbeatMs });
  const byState = {};
  for (const t of tasks) byState[t.state] = (byState[t.state] || 0) + 1;
  const optional = (name) => (existsSync(join(dir, name)) ? join(dir, name) : null);
  return {
    dir,
    name: basename(dir),
    project: basename(dirname(dir)),
    startedMs,
    finishedMs,
    stoppedMs,
    abortedMs,
    enginePid,
    ask,
    quietWarnMs,
    tasks,
    waves,
    totals: { byState },
    digestPath: optional("digest.md"),
    reportPath: optional("report.md"),
    summaryPath: optional("summary.json"),
  };
}

// The raw run-directory keys, and nothing else. Grouping needs the FULL key set
// for its common-prefix derivation, but only the names  listRuns would stat and
// liveness-check every run in the estate to hand back the same strings.
export function projectKeys(home, { _readdir = readdirSync } = {}) {
  try { return _readdir(join(home, "runs")); } catch { return []; }
}

// Every run dir under <home>/runs/<project>/<run>/, newest run.log first.
// `active` = runLiveness reports neither a terminal summary nor a stale heartbeat.
// `aborted` = the engine went quiet (or never wrote a heartbeat at all) with no
// summary. `stopped` = a deliberate `swarm stop`, distinct from a plain finish.
export function listRuns(home, { now = Date.now(), heartbeatMs = 15_000, _readFile = readFileSync } = {}) {
  const runsRoot = join(home, "runs");
  const out = [];
  let projects = [];
  try { projects = readdirSync(runsRoot); } catch { return out; }
  for (const project of projects) {
    let runs = [];
    try { runs = readdirSync(join(runsRoot, project)); } catch { continue; }
    for (const name of runs) {
      const dir = join(runsRoot, project, name);
      const logPath = join(dir, "run.log");
      let logStat;
      try { logStat = statSync(logPath); } catch { continue; }
      const { finishedMs, stoppedMs, abortedMs } = runLiveness(dir, { now, heartbeatMs, _readFile });
      const finished = finishedMs != null || stoppedMs != null;
      const aborted = abortedMs != null;
      const active = !finished && !aborted;
      // Only live rows need startedMs for the sort below — reading it for a finished
      // run would defeat the mtime gate that lets runLiveness skip run.log entirely.
      const startedMs = active
        ? (lastRunStart(logPath, logStat.mtimeMs, logStat.size, _readFile).startedMs ?? logStat.mtimeMs)
        : null;
      out.push({ dir, project, name, mtimeMs: logStat.mtimeMs, startedMs, active, aborted, stopped: stoppedMs != null });
    }
  }
  // Live rows first, most recently DISPATCHED on top and staying there — sorting by
  // mtime instead would float whichever engine last appended an event, jumping rows
  // on every poll. Finished/stopped/aborted rows follow, by mtime as before.
  return out.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.active ? b.startedMs - a.startedMs : b.mtimeMs - a.mtimeMs;
  });
}

// The one liveness rule every reader shares. A run is:
//   - `stoppedMs`  — a terminal summary with `stopped: true` (checked before finished,
//                    so a stop is never mistaken for a plain finish)
//   - `finishedMs` — a terminal, non-stopped summary
//   - alive        — no trusted summary, and the heartbeat file is younger than
//                    `heartbeatMs * 3`
//   - `abortedMs`  — none of the above: the heartbeat (or, for a pre-heartbeat run,
//                    run.log itself) went quiet with no terminal record
// A recorded engine pid is NEVER consulted — that pid-reuse guess is the defect
// this predicate replaces. The mtime gate + memoised lastRunStart preserve
// listRuns' per-poll cost: a finished run's summary is trusted without touching
// run.log at all.
export function runLiveness(dir, { now = Date.now(), heartbeatMs = 15_000, _readFile = readFileSync } = {}) {
  dir = resolve(dir);
  const logPath = join(dir, "run.log");
  const summaryPath = join(dir, "summary.json");
  let logStat;
  try { logStat = statSync(logPath); } catch { return { finishedMs: null, stoppedMs: null, abortedMs: null }; }
  let summaryStat = null;
  try { summaryStat = statSync(summaryPath); } catch { /* never finished */ }

  let summary = null;
  if (summaryStat) {
    const gatedFinished = logStat.mtimeMs <= summaryStat.mtimeMs;
    if (gatedFinished) {
      summary = readJson(summaryPath);
    } else {
      // The log grew after the summary was written: a resume may have superseded it.
      const started = lastRunStart(logPath, logStat.mtimeMs, logStat.size, _readFile);
      let candidate = null;
      try { candidate = JSON.parse(_readFile(summaryPath, "utf8")); } catch { /* mid-write */ }
      const finishedMs = candidate?.finished ? Date.parse(candidate.finished) || null : null;
      if (!summarySuperseded(finishedMs, started.startedMs)) summary = candidate;
    }
  }
  if (summary?.finished) {
    const finishedMs = Date.parse(summary.finished) || null;
    return summary.stopped
      ? { finishedMs: null, stoppedMs: finishedMs, abortedMs: null }
      : { finishedMs, stoppedMs: null, abortedMs: null };
  }
  const hb = readHeartbeat(dir);
  if (hb && now - hb.mtimeMs < heartbeatMs * 3) return { finishedMs: null, stoppedMs: null, abortedMs: null };
  return { finishedMs: null, stoppedMs: null, abortedMs: hb ? hb.mtimeMs : logStat.mtimeMs };
}

// logPath -> { mtimeMs, size, pid, startedMs }. The last run-start's pid/ts can only
// change when the log is appended, so the mtime+size listRuns already has is a sound
// cache key. Unbounded by run count (entries are four fields); stale entries for
// deleted runs are inert.
const runStartCache = new Map();

// The engine pid and start ts from the LAST run-start line — the engine currently
// driving the run, and the ts summarySuperseded compares against. Only reached past
// the gate (an unfinished run, or one whose log outgrew its summary), but
// "unfinished" accumulates: every aborted run that never wrote a summary stays in
// the set forever. The dashboard polls listRuns, so an uncached read here is once
// per tick per such run — 521 logs / 39MB on one real estate. Hence the memo; pass
// mtimeMs to use it. A failed read is never memoised, so a transient error retries.
function lastRunStart(logPath, mtimeMs, size, readFile = readFileSync) {
  const hit = runStartCache.get(logPath);
  // Keyed on mtime AND size: mtimeMs has millisecond resolution, so an append landing
  // in the same tick as the cached stat would otherwise serve a stale entry — and a
  // resume appends a run-start with a NEW pid/ts, which is exactly the reaped-engine
  // misjudgment 0a01433 fixed. A resume always grows the file, so size closes it.
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return { pid: hit.pid, startedMs: hit.startedMs };
  let text;
  try { text = readFile(logPath, "utf8"); } catch { return { pid: null, startedMs: null }; }
  // Line-oriented, key-order independent: run.log is one JSON object per line, so
  // the last line naming a run-start IS the last run-start, whatever order its keys
  // are in — unlike a regex anchored on `"ts"` coming before `"event"`.
  let last = { pid: null, startedMs: null };
  for (const line of text.split("\n")) {
    if (!line.includes('"event":"run-start"')) continue;
    try {
      const e = JSON.parse(line);
      last = { pid: Number.isInteger(e.pid) ? e.pid : null, startedMs: Date.parse(e.ts) || null };
    } catch { /* torn tail write mid-run */ }
  }
  // Bounded rather than pruned: entries are four fields and are capped by run dirs the
  // daemon has seen, but a daemon runs for weeks — clearing wholesale costs one sweep.
  if (runStartCache.size > 10_000) runStartCache.clear();
  if (mtimeMs !== undefined) runStartCache.set(logPath, { mtimeMs, size, pid: last.pid, startedMs: last.startedMs });
  return last;
}

// A summary written before the run was restarted describes a dead engine's pass,
// not this one. Compared on the ENGINE'S OWN timestamps, never file mtimes: a touch
// of summary.json (restore, copy, AV scan) would otherwise mark a finished run
// superseded, permanently.
export function summarySuperseded(summaryFinishedMs, lastRunStartMs) {
  return summaryFinishedMs != null && lastRunStartMs != null && lastRunStartMs > summaryFinishedMs;
}
