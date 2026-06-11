import { test } from "node:test";
import { ok, equal } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectPath, close, projectAdd, rowAdd, rowGet } from "../scripts/pipeline-db/index.mjs";
import { spawnSession } from "../scripts/orchestrator/spawn.mjs";

const PROJECT = "testproject";

function createMockLog() {
  const logs = [];
  const fn = (msg, level = "INFO") => { logs.push({ msg, level }); };
  fn.getLogs = () => logs;
  fn.hasMessage = (substr) => logs.some(l => l.msg.includes(substr));
  return fn;
}

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "spawn-escalation-"));
  const dbPath = join(tmp, "pipeline.db");
  const projectRoot = join(tmp, "project");
  mkdirSync(join(projectRoot, ".git"), { recursive: true });
  const db = connectPath(dbPath);
  projectAdd(db, { name: PROJECT, rootPath: projectRoot });
  return { tmp, db, projectRoot };
}

function teardown(tmp, db) {
  try { close(db); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

test("escalation: does NOT escalate when review_retries = 0", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-0";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 0,
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=claude-haiku-4-5-20251001";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(!logFn.hasMessage("auto-escalating"), "Should not escalate when review_retries = 0");
  } finally { teardown(tmp, db); }
});

test("escalation: does NOT escalate when review_retries = 1", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-1";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 1,
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=claude-haiku-4-5-20251001";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(!logFn.hasMessage("auto-escalating"), "Should not escalate when review_retries = 1");
  } finally { teardown(tmp, db); }
});

test("escalation: ESCALATES when review_retries >= 2 and model is Haiku", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-2";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 2,
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=claude-haiku-4-5-20251001";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(logFn.hasMessage("auto-escalating"), "Should escalate at review_retries >= 2");
    ok(logFn.hasMessage("claude-sonnet-4-6"), "Should escalate to Sonnet");
  } finally { teardown(tmp, db); }
});

test("escalation: does NOT escalate when already Sonnet", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-sonnet";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 2,
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=claude-sonnet-4-6";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(!logFn.hasMessage("auto-escalating"), "Should not escalate when already Sonnet");
  } finally { teardown(tmp, db); }
});

test("escalation: does NOT escalate for review stype", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-review";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 2,
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=review model=claude-haiku-4-5-20251001";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(!logFn.hasMessage("auto-escalating"), "Should not escalate for review stype");
  } finally { teardown(tmp, db); }
});

test("escalation: persists d_model to DB", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-persist";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 2,
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=claude-haiku-4-5-20251001";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    const updated = rowGet(db, PROJECT, feature);
    equal(updated.d_model, "claude-sonnet-4-6", "d_model should be updated in DB");
  } finally { teardown(tmp, db); }
});
