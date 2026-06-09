// smoke-17: cycle_log schema + appendCycleLog/loadCycleLog round-trip.
import { test } from "node:test";
import { equal, ok, deepEqual, throws } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  connectPath, close,
  projectAdd,
  appendCycleLog, loadCycleLog,
} from "../scripts/pipeline-db/index.mjs";

const PROJECT = "testproject";

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "smoke17-"));
  const dbPath = join(tmp, "pipeline.db");
  const root = join(tmp, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(dbPath);
  projectAdd(db, { name: PROJECT, rootPath: root });
  return { tmp, db };
}

function teardown(tmp, db) {
  try { close(db); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

test("cycle_log: table created in initial schema", () => {
  const { tmp, db } = setup();
  try {
    // Schema present means no exception on the simplest SELECT
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cycle_log'").all();
    equal(rows.length, 1);
  } finally { teardown(tmp, db); }
});

test("appendCycleLog + loadCycleLog: round-trip with all fields", () => {
  const { tmp, db } = setup();
  try {
    appendCycleLog(db, {
      project:        PROJECT,
      feature:        "feat-x",
      stage:          "dev",
      correlation_id: "feat-x-20260608T010203Z",
      start_time:     "2026-06-08T01:00:00Z",
      end_time:       "2026-06-08T01:02:22Z",
      duration_secs:  142.0,
      spend_tokens:   18400,
      outcome:        "pass",
    });
    const rows = loadCycleLog(db, { project: PROJECT });
    equal(rows.length, 1);
    const r = rows[0];
    equal(r.project,        PROJECT);
    equal(r.feature,        "feat-x");
    equal(r.stage,          "dev");
    equal(r.duration_secs,  142.0);
    equal(r.spend_tokens,   18400);
    equal(r.outcome,        "pass");
    equal(r.correlation_id, "feat-x-20260608T010203Z");
  } finally { teardown(tmp, db); }
});

test("loadCycleLog: filters by feature", () => {
  const { tmp, db } = setup();
  try {
    appendCycleLog(db, { project: PROJECT, feature: "feat-a", stage: "dev", start_time: "2026-06-08T01:00Z", end_time: "2026-06-08T01:01Z", outcome: "pass" });
    appendCycleLog(db, { project: PROJECT, feature: "feat-b", stage: "dev", start_time: "2026-06-08T02:00Z", end_time: "2026-06-08T02:01Z", outcome: "pass" });
    const rows = loadCycleLog(db, { project: PROJECT, feature: "feat-b" });
    equal(rows.length, 1);
    equal(rows[0].feature, "feat-b");
  } finally { teardown(tmp, db); }
});

test("loadCycleLog: most-recent-first ordering", () => {
  const { tmp, db } = setup();
  try {
    appendCycleLog(db, { project: PROJECT, feature: "feat-a", stage: "dev", start_time: "x", end_time: "2026-06-08T01:00:00Z", outcome: "pass" });
    appendCycleLog(db, { project: PROJECT, feature: "feat-b", stage: "dev", start_time: "x", end_time: "2026-06-08T03:00:00Z", outcome: "pass" });
    appendCycleLog(db, { project: PROJECT, feature: "feat-c", stage: "dev", start_time: "x", end_time: "2026-06-08T02:00:00Z", outcome: "pass" });
    const rows = loadCycleLog(db, { project: PROJECT });
    deepEqual(rows.map(r => r.feature), ["feat-b", "feat-c", "feat-a"]);
  } finally { teardown(tmp, db); }
});

test("loadCycleLog: respects limit", () => {
  const { tmp, db } = setup();
  try {
    for (let i = 0; i < 5; i++) {
      appendCycleLog(db, {
        project: PROJECT, feature: `feat-${i}`, stage: "dev",
        start_time: "x", end_time: `2026-06-08T0${i}:00:00Z`, outcome: "pass",
      });
    }
    const rows = loadCycleLog(db, { project: PROJECT, limit: 2 });
    equal(rows.length, 2);
  } finally { teardown(tmp, db); }
});

test("cycle_log: outcome CHECK rejects unknown values", () => {
  const { tmp, db } = setup();
  try {
    throws(
      () => db.prepare(
        "INSERT INTO cycle_log (project, feature, stage, start_time, end_time, outcome) " +
        "VALUES ('p', 'f', 'dev', 'x', 'y', 'banana')"
      ).run(),
      /CHECK constraint failed/i
    );
  } finally { teardown(tmp, db); }
});

test("appendCycleLog: missing optional fields nullified", () => {
  const { tmp, db } = setup();
  try {
    appendCycleLog(db, {
      project: PROJECT, feature: "feat-x", stage: "dev",
      start_time: "x", end_time: "y", outcome: "pass",
    });
    const rows = loadCycleLog(db, { project: PROJECT });
    equal(rows[0].duration_secs,  null);
    equal(rows[0].spend_tokens,   null);
    equal(rows[0].correlation_id, null);
  } finally { teardown(tmp, db); }
});
