import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRunLog, readRun } from "../src/runlog.mjs";
import { NOW } from "./fixtures/run-fixture.mjs";
import { withFixture } from "./helpers/runlog-fixture.mjs";

const require_runlog = () => ({ readRunLog });

// A coverage shortfall never fails the leaf — `finish` records it and the runner's
// closing block is the only other place it exists. So a reader that drops the event
// leaves a leaf that read 3 of 430 required lines looking exactly like a clean one.
test("readRunLog: a leaf's coverage status reaches its row, and a resume clears it", () => {
  const { readRunLog } = require_runlog();
  const log = [
    '{"event":"run-start","tasks":["a","b"]}',
    '{"id":"a","event":"coverage","status":"incomplete","required":430,"read":3,"missed":["x"]}',
    '{"id":"a","state":"ok"}',
    '{"id":"b","state":"ok"}',
  ].join("\n");
  const byId = Object.fromEntries(readRunLog(log, { now: NOW }).tasks.map((t) => [t.id, t]));
  assert.equal(byId.a.coverage.status, "incomplete");
  assert.equal(byId.a.coverage.read, 3);
  assert.equal(byId.a.state, "ok", "recorded, never fatal");
  assert.equal(byId.b.coverage, undefined, "a leaf with no coverage event carries none");
  // run-start clears per-leaf state; a shortfall from the superseded attempt must not
  // survive onto the new one and warn forever.
  const resumed = readRunLog(`${log}\n{"event":"run-start","tasks":["a"]}`, { now: NOW });
  assert.equal(resumed.tasks[0].coverage, undefined);
});

test("readRun: the coverage status survives topology onto the row the dashboard reads", () => {
  withFixture(({ dir }) => {
    const logPath = join(dir, "run.log");
    writeFileSync(logPath, `${readFileSync(logPath, "utf8")}\n${JSON.stringify({
      ts: "2026-09-05T01:09:00.000Z", event: "coverage", id: "find-a",
      status: "unparseable", required: 12, read: 0, missed: [], retried: false,
    })}\n`, "utf8");
    const run = readRun(dir, { now: NOW, quietWarnMs: 60_000 });
    const byId = Object.fromEntries(run.tasks.map((t) => [t.id, t]));
    assert.equal(byId["find-a"].coverage.status, "unparseable", "the endpoint's field list needs it on the row");
    assert.equal(byId["find-a"].state, "ok", "an unreadable transcript still is not a failure");
    assert.equal(byId["find-b"].coverage, undefined);
  });
});
