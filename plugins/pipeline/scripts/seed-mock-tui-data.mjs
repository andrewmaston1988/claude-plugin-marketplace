// One-shot dashboard seed: long notes for marquee + mock active sessions
// for the running-icon animation. Run from the plugin dir.
//   node scripts/seed-mock-tui-data.mjs
import { connectUnified, close } from "./pipeline-db/index.mjs";
import { getPaths } from "../src/paths.mjs";

const paths = getPaths();
const db = connectUnified(paths);
const PROJECT = "torrent-hub";

const noteUpdates = [
  ["test-dev",      "implementing the new session resume logic so spawn carries over agent progress across restarts of the orchestrator"],
  ["test-review",   "judge panel scored 7/10 — risk-first attempt prefers a smaller diff; correctness verifier flagged the retry counter"],
  ["test-test",     "smoke harness ran 113 cases; flaky test deflaked on first re-run, full run green"],
  ["test-merge",    "branch ahead of master by 18 commits; PR description drafted; squash-merge gate green"],
  ["test-manual",   "blocked: needs operator to choose between option A (rebuild the index) and option B (add a fallback path)"],
  ["test-backlog",  "deferred to next iteration — relates to the cycle_log observability work in plan-12"],
  ["test-queued",   "type=dev autonomous spawn pending; expecting dev session in the next reaper tick"],
];

const stmt = db.prepare("UPDATE pipeline_rows SET notes_extra = ? WHERE project = ? AND feature = ?");
for (const [feature, note] of noteUpdates) {
  const r = stmt.run(note, PROJECT, feature);
  process.stdout.write(`notes_extra on ${feature}: ${r.changes ? "updated" : "no row"}\n`);
}

const sessStmt = db.prepare(`INSERT OR REPLACE INTO sessions
  (correlation_id, session_id, project, feature, session_type, cwd, session_file, spawn_time, pid, is_active)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);

// Mock progress so the agents panel shows a populated bar + step/total.
const pfStmt = db.prepare(`INSERT OR REPLACE INTO progress_files (slug, project, session_type, is_active) VALUES (?, ?, ?, 1)`);
const psDel  = db.prepare(`DELETE FROM progress_steps WHERE slug = ?`);
const psStmt = db.prepare(`INSERT INTO progress_steps (slug, step_index, content, state) VALUES (?, ?, ?, ?)`);

// Each entry exercises a different agent-panel state:
//   inprog       → spin in stage color
//   finished     → ✓ dim
//   stalled      → ● yellow  (in_progress + spawn_time > 30m ago)
//   dead         → ✗ red     (pid not alive)
//   idle         → · dim     (no progress yet)
const sessions = [
  { feature: "test-dev",     stype: "dev",      spawnMin: 12,   pid: 0,     steps: ["completed","completed","completed","completed","completed","in_progress","pending","pending","pending","pending","pending","pending"] },
  { feature: "test-review",  stype: "review",   spawnMin: 3,    pid: 0,     steps: ["completed","in_progress","pending","pending","pending"] },
  { feature: "test-test",    stype: "test",     spawnMin: 7,    pid: 0,     steps: ["completed","completed","completed","completed","completed","completed","completed","in_progress"] },
  { feature: "test-merge",   stype: "dev",      spawnMin: 90,   pid: 0,     steps: ["completed","completed","completed","completed","completed","completed","completed","completed"] },                                  // FINISHED
  { feature: "test-manual",  stype: "research", spawnMin: 65,   pid: 0,     steps: ["completed","completed","in_progress","pending","pending","pending"] },                                                              // STALLED (>30m + inprog)
  { feature: "test-backlog", stype: "dev",      spawnMin: 2,    pid: 999999,steps: ["pending","pending","pending","pending"] },                                                                                          // DEAD (pid not alive)
  { feature: "test-queued",  stype: "research", spawnMin: 1,    pid: 0,     steps: ["pending","pending","pending"] },                                                                                                    // IDLE
];

for (let i = 0; i < sessions.length; i++) {
  const { feature, stype, spawnMin, pid, steps } = sessions[i];
  const slug    = `${stype}-2026-06-08-${feature}`;
  const cid     = `mock-${stype}-${feature}-${Date.now()}-${i}`;
  const spawnTime = new Date(Date.now() - spawnMin * 60_000).toISOString();
  sessStmt.run(cid, cid, PROJECT, feature, stype, "C:/code/torrent-hub", `${slug}.md`, spawnTime, pid);
  pfStmt.run(slug, PROJECT, stype);
  psDel.run(slug);
  for (let j = 0; j < steps.length; j++) psStmt.run(slug, j, `step ${j+1}`, steps[j]);
  const done = steps.filter(s => s === "completed").length;
  const inp  = steps.filter(s => s === "in_progress").length;
  const tag  = (pid && pid !== 0) ? "dead?" : inp ? (spawnMin > 30 ? "stalled?" : "inprog") : done > 0 ? "finished" : "idle";
  process.stdout.write(`session ${slug} (${spawnMin}m, pid ${pid}) — ${done}/${steps.length} ${tag}\n`);
}

// Mock orchestrator state file so the dashboard header shows orch running.
//   PID 0 — loadOrchState treats pid<=4 as alive when status=running
//   started_at — 22m ago / last_poll — 1s ago
import { mkdirSync as _mkdirSync, writeFileSync as _writeFileSync } from "node:fs";
import { dirname as _dirname } from "node:path";
import { homedir as _homedir } from "node:os";
import { join as _join } from "node:path";
const _stateFile = _join(_homedir(), ".pipeline", "orchestrator.state.json");
_mkdirSync(_dirname(_stateFile), { recursive: true });
_writeFileSync(_stateFile, JSON.stringify({
  status:     "running",
  pid:        0,
  started_at: new Date(Date.now() - 22 * 60_000).toISOString(),
  last_poll:  new Date(Date.now() - 1_000).toISOString(),
}, null, 2));
process.stdout.write(`orchestrator state mocked at ${_stateFile} (running, PID 0)\n`);

close(db);
process.stdout.write("done\n");
