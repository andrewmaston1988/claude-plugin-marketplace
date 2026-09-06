import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { glyphFromLog, newestRunLog } from "../statusline/swarm-glyph.mjs";
import { touchHeartbeat, heartbeatPath } from "../src/results.mjs";

const LOG = [
  '{"event":"run-start","tasks":[{"id":"a","model":"haiku"},{"id":"b","model":"haiku"},{"id":"c","model":"haiku"},{"id":"d","model":"haiku"},{"id":"e","model":"haiku"}]}',
  '{"id":"a","state":"ok","tokens":{"input":10000,"output":2000,"cacheCreation":0,"cacheRead":0}}',
  '{"id":"b","state":"running"}',
  '{"id":"b","event":"tokens","tokens":{"input":5000,"output":1000,"cacheCreation":0,"cacheRead":0}}',
  '{"id":"c","state":"rate-limited"}',
  '{"id":"d","state":"quota"}',
].join("\n");

test("glyphFromLog: counts per state with pending derived from run-start, plus token total", () => {
  const g = glyphFromLog(LOG);
  assert.match(g, /^🐝 /);
  assert.match(g, /1✓/);
  assert.match(g, /1▶/);
  assert.match(g, /1⧖/);
  assert.match(g, /1⏳/); // d quota
  assert.match(g, /1·/); // e pending
  assert.match(g, /18k/); // 12k final (a) + 6k live (b)
});

test("glyphFromLog: legacy run-start with plain id strings still counts pending", () => {
  const g = glyphFromLog('{"event":"run-start","tasks":["a","b"]}\n{"id":"a","state":"ok"}');
  assert.match(g, /1✓/);
  assert.match(g, /1·/);
  assert.ok(!/k/.test(g), "no token segment when nothing counted");
});

test("glyphFromLog: empty for no meaningful content", () => {
  assert.equal(glyphFromLog(""), "");
});

test("newestRunLog: picks the most recent run.log across projects", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-glyph-"));
  try {
    const older = join(home, "runs", "proj-a", "run-1");
    const newer = join(home, "runs", "proj-b", "run-9");
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    writeFileSync(join(older, "run.log"), "old", "utf8");
    writeFileSync(join(newer, "run.log"), "new", "utf8");
    const past = Date.now() / 1000 - 3600;
    utimesSync(join(older, "run.log"), past, past);
    const best = newestRunLog(home);
    assert.equal(best.path, join(newer, "run.log"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("newestRunLog: active reflects the run's heartbeat, not just being newest — no heartbeat at all is never active", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-glyph-active-"));
  try {
    const d = join(home, "runs", "proj-a", "run-1");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "run.log"), "x", "utf8");
    const best = newestRunLog(home);
    assert.equal(best.active, false, "a run that never wrote a heartbeat is never active");

    touchHeartbeat(d, new Date().toISOString(), process.pid);
    const fresh = newestRunLog(home);
    assert.equal(fresh.active, true, "a fresh heartbeat makes the newest run active");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- the fleet bar (swarm-statusline.mjs): session-scoped live runs ----
import { render as renderFleet, liveRuns } from "../statusline/swarm-statusline.mjs";

// `a` finishes ok, `b` is still running as of `quietMs` ago — state and ts are
// explicit on every event, since liveRuns now derives everything from run.log,
// not from results/ file presence.
function fleetHome({ now, quietMs = 0, finished = false, launcher = "sess-1" }) {
  const home = mkdtempSync(join(tmpdir(), "swarm-fleet-"));
  const rd = join(home, "runs", "C--code-x", "sweep-1");
  mkdirSync(rd, { recursive: true });
  const startTs = new Date(now - quietMs - 60_000).toISOString();
  const aTs = new Date(now - quietMs - 30_000).toISOString();
  const bTs = new Date(now - quietMs).toISOString();
  writeFileSync(join(rd, "run.log"), [
    JSON.stringify({ ts: startTs, event: "run-start", pid: 1, launcher, tasks: [{ id: "a", model: "glm-5.2:cloud" }, { id: "b", model: "minimax-m3:cloud" }] }),
    JSON.stringify({ ts: aTs, id: "a", state: "ok", tokens: { input: 900, output: 100, cacheCreation: 0, cacheRead: 5000 } }),
    JSON.stringify({ ts: bTs, id: "b", state: "running", tokens: { input: 1000, output: 500, cacheCreation: 0, cacheRead: 0 } }),
  ].join("\n") + "\n");
  const logT = now / 1000;
  utimesSync(join(rd, "run.log"), logT, logT);
  if (finished) {
    writeFileSync(join(rd, "summary.json"), JSON.stringify({ finished: new Date(now).toISOString() }));
    utimesSync(join(rd, "summary.json"), logT + 1, logT + 1);
  } else {
    touchHeartbeat(rd, new Date(now).toISOString(), 1);
    utimesSync(heartbeatPath(rd), logT, logT);
  }
  return home;
}

test("fleet bar: shows this session's live run — done/total, live symbol, seated models, work tokens (cache reads excluded)", () => {
  const now = Date.now();
  const home = fleetHome({ now });
  try {
    const line = renderFleet({ home, now, session: { session_id: "sess-1" } }).replace(/[[0-9;]*m/g, "");
    assert.match(line, /swarm/);
    assert.match(line, /sweep 1\/2 ◐/, line);
    assert.match(line, /minimax-m3/, "the model on the running leaf");
    assert.match(line, /2\.5k/, "900+100+1000+500, cacheRead ignored");
    assert.equal(renderFleet({ home, now, session: { session_id: "someone-else" } }), "", "another session's run is not ours");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("fleet bar: a quiet leaf is flagged in minutes; a finished run is not shown", () => {
  const now = Date.now();
  const quiet = fleetHome({ now, quietMs: 6 * 60_000 });
  const done = fleetHome({ now, finished: true });
  try {
    assert.match(renderFleet({ home: quiet, now, session: { session_id: "sess-1" } }).replace(/[[0-9;]*m/g, ""), /⚠ sweep b quiet 6m/);
    assert.equal(renderFleet({ home: done, now, session: { session_id: "sess-1" } }), "");
  } finally {
    rmSync(quiet, { recursive: true, force: true });
    rmSync(done, { recursive: true, force: true });
  }
});

// A leaf whose result `.log` outlives it — blocked, or a dead engine — must not read
// as running from file presence alone; state comes from run.log now (F1/F2).
function blockedOrRunningHome({ now, state }) {
  const home = mkdtempSync(join(tmpdir(), "swarm-fleet-f12-"));
  const rd = join(home, "runs", "C--code-x", "region-wide");
  mkdirSync(join(rd, "results"), { recursive: true });
  const startTs = new Date(now - 60 * 60_000).toISOString();
  const leafTs = new Date(now - 53 * 60_000).toISOString();
  writeFileSync(join(rd, "run.log"), [
    JSON.stringify({ ts: startTs, event: "run-start", pid: 1, launcher: "sess-1", tasks: [{ id: "sites", model: "m" }] }),
    JSON.stringify({ ts: leafTs, id: "sites", state }),
  ].join("\n") + "\n");
  writeFileSync(join(rd, "results", "sites.log"), "stale");
  const logT = now / 1000;
  utimesSync(join(rd, "run.log"), logT, logT);
  touchHeartbeat(rd, new Date(now).toISOString(), 1);
  utimesSync(heartbeatPath(rd), logT, logT);
  return home;
}

test("fleet bar: a blocked leaf with a stale results/.log is not reported running or quiet (F1)", () => {
  const now = Date.now();
  const home = blockedOrRunningHome({ now, state: "blocked" });
  try {
    const runs = liveRuns({ home, now, session: { session_id: "sess-1" } });
    const run = runs.find((r) => r.run === "region-wide");
    assert.ok(!run.running.includes("sites"), "blocked leaf must not read as running");
    assert.ok(!/quiet/.test(renderFleet({ home, now, session: { session_id: "sess-1" } })), "no quiet warning for a leaf that stopped running");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("fleet bar: a genuinely running leaf is still reported with its quiet age (F2)", () => {
  const now = Date.now();
  const home = blockedOrRunningHome({ now, state: "running" });
  try {
    const runs = liveRuns({ home, now, session: { session_id: "sess-1" } });
    const run = runs.find((r) => r.run === "region-wide");
    assert.ok(run.running.includes("sites"));
    assert.ok(run.quiet >= 52 * 60_000 && run.quiet <= 54 * 60_000, `quiet ${run.quiet}ms should be ~53min`);
    assert.match(renderFleet({ home, now, session: { session_id: "sess-1" } }), /quiet/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("fleet bar: a superseded-summary run is still live on the bar (F3)", () => {
  const now = Date.now();
  const home = mkdtempSync(join(tmpdir(), "swarm-fleet-f3-"));
  const rd = join(home, "runs", "C--code-x", "region-lanes-1");
  mkdirSync(rd, { recursive: true });
  try {
    const t0 = new Date(now - 10 * 60_000);
    writeFileSync(join(rd, "run.log"), JSON.stringify({ ts: t0.toISOString(), event: "run-start", pid: 999999, launcher: "sess-1", tasks: [{ id: "x", model: "m" }] }) + "\n");
    utimesSync(join(rd, "run.log"), t0.getTime() / 1000, t0.getTime() / 1000);
    // summary written by the engine that died right after — mtime just after t0
    const summaryT = t0.getTime() / 1000 + 1;
    writeFileSync(join(rd, "summary.json"), JSON.stringify({ finished: new Date(t0.getTime() + 500).toISOString() }));
    utimesSync(join(rd, "summary.json"), summaryT, summaryT);
    // a resume 30s past the summary's mtime — the live engine, this test's own pid
    const t1 = new Date(summaryT * 1000 + 30_000);
    const start2 = JSON.stringify({ ts: t1.toISOString(), event: "run-start", pid: process.pid, launcher: "sess-1", tasks: [{ id: "x", model: "m" }] });
    writeFileSync(join(rd, "run.log"), readFileSync(join(rd, "run.log"), "utf8") + start2 + "\n");
    utimesSync(join(rd, "run.log"), now / 1000, now / 1000); // fresh — past the summary, defeats the gate
    // the resumed engine (this test's own pid) is still ticking
    touchHeartbeat(rd, new Date(now).toISOString(), process.pid);
    utimesSync(heartbeatPath(rd), now / 1000, now / 1000);

    const runs = liveRuns({ home, now, session: { session_id: "sess-1" } });
    assert.ok(runs.find((r) => r.run === "region-lanes-1"), "the resumed run must still be reported live");
    const line = renderFleet({ home, now, session: { session_id: "sess-1" } });
    assert.notEqual(line, "", "the bar must not go blank while the resumed engine is alive");
    assert.match(line, /region-lanes-1|lanes/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("fleet bar: counts come from run.log state, not results/ file presence (F4)", () => {
  const now = Date.now();
  const home = mkdtempSync(join(tmpdir(), "swarm-fleet-f4-"));
  const rd = join(home, "runs", "C--code-x", "mixed-1");
  mkdirSync(join(rd, "results"), { recursive: true });
  try {
    const ts = (n) => new Date(now - n * 1000).toISOString();
    writeFileSync(join(rd, "run.log"), [
      JSON.stringify({ ts: ts(60), event: "run-start", pid: 1, launcher: "sess-1", tasks: [{ id: "a", model: "m" }, { id: "b", model: "m" }, { id: "c", model: "m" }, { id: "d", model: "m" }, { id: "e", model: "m" }] }),
      JSON.stringify({ ts: ts(50), id: "a", state: "ok" }),
      JSON.stringify({ ts: ts(40), id: "b", state: "skipped" }),
      JSON.stringify({ ts: ts(30), id: "c", state: "failed" }),
      JSON.stringify({ ts: ts(20), id: "d", state: "blocked" }),
      JSON.stringify({ ts: ts(10), id: "e", state: "running" }),
    ].join("\n") + "\n");
    // results/ deliberately disagrees: a .json for the BLOCKED leaf, none for the ok
    // one, and a stray .json for an id the roster never mentions.
    writeFileSync(join(rd, "results", "d.json"), JSON.stringify({ id: "d", ok: false }));
    writeFileSync(join(rd, "results", "zzz.json"), JSON.stringify({ id: "zzz", ok: true }));
    utimesSync(join(rd, "run.log"), now / 1000, now / 1000);
    touchHeartbeat(rd, new Date(now).toISOString(), 1);
    utimesSync(heartbeatPath(rd), now / 1000, now / 1000);

    const run = liveRuns({ home, now, session: { session_id: "sess-1" } }).find((r) => r.run === "mixed-1");
    assert.equal(run.ok, 2, "ok + skipped");
    assert.equal(run.failed, 2, "failed + blocked");
    assert.equal(run.total, 5, "roster length; the stray zzz.json contributes nothing");
    assert.ok(run.running.includes("e"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// GUARD, not a RED case: exercises the pre-existing mine()/launcher filter, which
// this change does not touch. Pinned because the rewrite happens around it.
test("fleet bar: no live run of this session renders an empty string, not idle (F5)", () => {
  const now = Date.now();
  const home = fleetHome({ now });
  try {
    assert.equal(renderFleet({ home, now, session: { session_id: "not-this-session" } }), "");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
