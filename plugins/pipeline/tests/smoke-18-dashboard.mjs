// smoke-18: dashboard shared loaders — read-only data accessors used by both
// TUI and web. UI rendering is not auto-tested (matches Python upstream).
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectPath, close, projectAdd, rowAdd } from "../scripts/pipeline-db/index.mjs";
import { loadProjects, loadRows } from "../src/dashboard/shared/load-rows.mjs";
import { loadActiveSessions } from "../src/dashboard/shared/load-sessions.mjs";
import { loadRecentCycles } from "../src/dashboard/shared/load-cycle-log.mjs";
import { loadOrchState } from "../src/dashboard/shared/load-orch-state.mjs";
import { appendCycleLog } from "../scripts/pipeline-db/index.mjs";

const PROJECT = "testproject";

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "smoke18-"));
  const dbPath = join(tmp, "pipeline.db");
  const repo = join(tmp, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const db = connectPath(dbPath);
  projectAdd(db, { name: PROJECT, rootPath: repo });
  return { tmp, db };
}

function teardown(tmp, db) {
  try { close(db); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

test("loadProjects: returns enabled projects by default", () => {
  const { tmp, db } = setup();
  try {
    const ps = loadProjects(db);
    equal(ps.length, 1);
    equal(ps[0].name, PROJECT);
  } finally { teardown(tmp, db); }
});

test("loadRows: hides done rows by default, shows all when showAll=true", () => {
  const { tmp, db } = setup();
  try {
    rowAdd(db, PROJECT, { feature: "f-active", planFile: "/a/b.md", stage: "queued" });
    rowAdd(db, PROJECT, { feature: "f-done",   planFile: "/a/c.md", stage: "done" });
    equal(loadRows(db, PROJECT).length, 1);
    equal(loadRows(db, PROJECT, { showAll: true }).length, 2);
  } finally { teardown(tmp, db); }
});

test("loadActiveSessions: empty for fresh project", () => {
  const { tmp, db } = setup();
  try {
    const ss = loadActiveSessions(db, PROJECT);
    equal(ss.length, 0);
  } finally { teardown(tmp, db); }
});

test("loadRecentCycles: returns cycle_log rows for project, most-recent-first", () => {
  const { tmp, db } = setup();
  try {
    appendCycleLog(db, { project: PROJECT, feature: "a", stage: "dev", start_time: "x", end_time: "2026-06-08T01:00Z", outcome: "pass" });
    appendCycleLog(db, { project: PROJECT, feature: "b", stage: "dev", start_time: "x", end_time: "2026-06-08T03:00Z", outcome: "pass" });
    appendCycleLog(db, { project: PROJECT, feature: "c", stage: "dev", start_time: "x", end_time: "2026-06-08T02:00Z", outcome: "pass" });
    const recs = loadRecentCycles(db, PROJECT);
    equal(recs.length, 3);
    equal(recs[0].feature, "b");
  } finally { teardown(tmp, db); }
});

test("loadRecentCycles: feature filter", () => {
  const { tmp, db } = setup();
  try {
    appendCycleLog(db, { project: PROJECT, feature: "a", stage: "dev", start_time: "x", end_time: "y", outcome: "pass" });
    appendCycleLog(db, { project: PROJECT, feature: "b", stage: "dev", start_time: "x", end_time: "y", outcome: "pass" });
    const recs = loadRecentCycles(db, PROJECT, { feature: "b" });
    equal(recs.length, 1);
    equal(recs[0].feature, "b");
  } finally { teardown(tmp, db); }
});

test("loadOrchState: returns absent shape when no state file", () => {
  const orig = process.env.PIPELINE_STATE_FILE;
  try {
    // Even with no state file, loader should return a stable shape, not throw
    const s = loadOrchState();
    ok(typeof s === "object");
    ok("status" in s);
    ok("pid" in s);
    ok("alive" in s);
  } finally {
    if (orig !== undefined) process.env.PIPELINE_STATE_FILE = orig;
  }
});
