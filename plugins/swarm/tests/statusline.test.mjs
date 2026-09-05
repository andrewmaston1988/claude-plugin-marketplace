import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { glyphFromLog, newestRunLog } from "../statusline/swarm-glyph.mjs";

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

// ---- the fleet bar (swarm-statusline.mjs): session-scoped live runs ----
import { render as renderFleet } from "../statusline/swarm-statusline.mjs";

function fleetHome({ now, quietMs = 0, finished = false, launcher = "sess-1" }) {
  const home = mkdtempSync(join(tmpdir(), "swarm-fleet-"));
  const rd = join(home, "runs", "C--code-x", "sweep-1");
  mkdirSync(join(rd, "results"), { recursive: true });
  writeFileSync(join(rd, "manifest.json"), JSON.stringify({ tasks: [{ id: "a", model: "glm-5.2:cloud" }, { id: "b", model: "minimax-m3:cloud" }] }));
  writeFileSync(join(rd, "run.log"), [
    JSON.stringify({ event: "run-start", pid: 1, launcher, tasks: [{ id: "a", model: "glm-5.2:cloud" }, { id: "b", model: "minimax-m3:cloud" }] }),
    JSON.stringify({ id: "a", event: "tokens", tokens: { input: 900, output: 100, cacheCreation: 0, cacheRead: 5000 } }),
    JSON.stringify({ id: "b", event: "tokens", tokens: { input: 1000, output: 500, cacheCreation: 0, cacheRead: 0 } }),
  ].join("\n") + "\n");
  writeFileSync(join(rd, "results", "a.json"), JSON.stringify({ id: "a", ok: true }));
  writeFileSync(join(rd, "results", "b.log"), "working");
  const t = (now - quietMs) / 1000;
  utimesSync(join(rd, "results", "b.log"), t, t);
  utimesSync(join(rd, "run.log"), now / 1000, now / 1000);
  if (finished) writeFileSync(join(rd, "summary.json"), "{}");
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
