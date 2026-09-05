// One reader for a run's on-disk records. run.log is the truth for state; the
// manifest snapshot supplies the graph; summary.json says when it finished.
// Pure data out — the roster, the statusline glyph and the dashboard all render
// from this, so none of them carries its own parser.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { DIGEST_ID } from "./digest.mjs";

const CLONE_RE = /^(.+)\[(\d+)\]$/;

// Parse run.log text into per-task rows in roster order. `now` stands in for a
// missing timestamp (pre-ts logs) and anchors quietMs.
export function readRunLog(content, { now = Date.now() } = {}) {
  let roster = [];
  let startedMs = null;
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
    if (entry.event === "run-start") {
      // pre-token logs recorded plain id strings
      roster = (entry.tasks || []).map((t) => (typeof t === "string" ? { id: t, model: "?" } : t));
      startedMs = Date.parse(entry.ts) || now;
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
  return { startedMs, tasks };
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
export function readRun(dir, { now = Date.now(), quietWarnMs = 60_000 } = {}) {
  dir = resolve(dir);
  const logPath = join(dir, "run.log");
  if (!existsSync(logPath)) return null;
  const { startedMs, tasks: logged } = readRunLog(readFileSync(logPath, "utf8"), { now });
  const manifest = readJson(join(dir, "manifest.json"));
  const { tasks, waves } = topology(logged, manifest);
  const summary = readJson(join(dir, "summary.json"));
  const finishedMs = summary?.finished ? Date.parse(summary.finished) || null : null;
  const byState = {};
  for (const t of tasks) byState[t.state] = (byState[t.state] || 0) + 1;
  const optional = (name) => (existsSync(join(dir, name)) ? join(dir, name) : null);
  return {
    dir,
    name: basename(dir),
    project: basename(dirname(dir)),
    startedMs,
    finishedMs,
    quietWarnMs,
    tasks,
    waves,
    totals: { byState },
    digestPath: optional("digest.md"),
    reportPath: optional("report.md"),
    summaryPath: optional("summary.json"),
  };
}

// Every run dir under <home>/runs/<project>/<run>/, newest run.log first.
// `active` = written within recentMs and not yet summarised.
export function listRuns(home, { now = Date.now(), recentMs = 30 * 60_000 } = {}) {
  const runsRoot = join(home, "runs");
  const out = [];
  let projects = [];
  try { projects = readdirSync(runsRoot); } catch { return out; }
  for (const project of projects) {
    let runs = [];
    try { runs = readdirSync(join(runsRoot, project)); } catch { continue; }
    for (const name of runs) {
      const dir = join(runsRoot, project, name);
      let mtimeMs;
      try { mtimeMs = statSync(join(dir, "run.log")).mtimeMs; } catch { continue; }
      const finished = existsSync(join(dir, "summary.json"));
      out.push({ dir, project, name, mtimeMs, active: !finished && now - mtimeMs < recentMs });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
