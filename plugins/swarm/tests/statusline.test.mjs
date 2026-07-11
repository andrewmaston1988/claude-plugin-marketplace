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
