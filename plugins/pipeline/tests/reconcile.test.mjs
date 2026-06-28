import { test } from "node:test";
import { strictEqual, ok, match } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { connectPath, close } from "../scripts/pipeline-db/index.mjs";
import {
  sessionsActive, projectHasActiveSession, countActiveSessions,
  sessionRecordSpawn, sessionFinish, rowAdd, rowGet, rowUpdate,
  projectAdd, projectSetEnabled, sessionSetId,
} from "../scripts/pipeline-db/index.mjs";
import { reconcileSessions } from "../scripts/orchestrator/reaper.mjs";

function createMockLog() {
  const logs = [];
  const fn = (msg, level = "INFO") => { logs.push({ msg, level }); };
  fn.getLogs = () => logs;
  fn.hasMessage = (substr) => logs.some(l => l.msg.includes(substr));
  fn.getMessages = () => logs.map(l => l.msg);
  return fn;
}

function initGitRepo(projDir) {
  mkdirSync(projDir, { recursive: true });
  mkdirSync(join(projDir, ".git"), { recursive: true });
  writeFileSync(join(projDir, "README.md"), "# Test\n", "utf8");
}

function initDb() {
  const dbDir = mkdtempSync(tmpdir() + "/test-orch-");
  const db = connectPath(`${dbDir}/test.db`);
  return { db, dbDir };
}

function cleanupDb(db, dbDir) {
  close(db);
  rmSync(dbDir, { recursive: true, force: true });
}

// ── countActiveSessions ───────────────────────────────────────────────────────

test("countActiveSessions returns 0 on empty DB", () => {
  const { db, dbDir } = initDb();
  try {
    const count = countActiveSessions(db);
    strictEqual(count, 0);
  } finally {
    cleanupDb(db, dbDir);
  }
});

test("countActiveSessions counts only active sessions", () => {
  const { db, dbDir } = initDb();
  const projDir = join(dbDir, "proj");
  try {
    initGitRepo(projDir);
    projectAdd(db, { name: "proj", rootPath: projDir });

    // Add two active sessions
    sessionRecordSpawn(db, {
      correlationId: "corr-1",
      project: "proj",
      feature: "feat-1",
      sessionType: "dev",
      cwd: "/tmp/proj",
      sessionFile: "sessions/dev.md",
      pid: 9999,
    });

    sessionRecordSpawn(db, {
      correlationId: "corr-2",
      project: "proj",
      feature: "feat-2",
      sessionType: "review",
      cwd: "/tmp/proj",
      sessionFile: "sessions/review.md",
      pid: 9998,
    });

    // Finish one
    sessionFinish(db, "corr-1");

    // Count should be 1 (only corr-2 is active)
    const count = countActiveSessions(db);
    strictEqual(count, 1);
  } finally {
    cleanupDb(db, dbDir);
  }
});

// ── sessionsActive ────────────────────────────────────────────────────────────

test("sessionsActive returns active sessions only", () => {
  const { db, dbDir } = initDb();
  const projDir = join(dbDir, "proj");
  try {
    initGitRepo(projDir);
    projectAdd(db, { name: "proj", rootPath: projDir });

    sessionRecordSpawn(db, {
      correlationId: "corr-1",
      project: "proj",
      feature: "feat-1",
      sessionType: "dev",
      cwd: "/tmp/proj",
      sessionFile: "sessions/dev.md",
      pid: 9999,
    });

    sessionFinish(db, "corr-1");

    sessionRecordSpawn(db, {
      correlationId: "corr-2",
      project: "proj",
      feature: "feat-2",
      sessionType: "review",
      cwd: "/tmp/proj",
      sessionFile: "sessions/review.md",
      pid: 9998,
    });

    const active = sessionsActive(db);
    strictEqual(active.length, 1);
    strictEqual(active[0].correlation_id, "corr-2");
  } finally {
    cleanupDb(db, dbDir);
  }
});

// ── reconcileSessions: orphaned review ────────────────────────────────────────

test("reconcileSessions parks orphaned review (pid dead, stage unchanged)", () => {
  const { db, dbDir } = initDb();
  const projDir = join(dbDir, "proj");
  try {
    initGitRepo(projDir);
    projectAdd(db, { name: "proj", rootPath: projDir });
    projectSetEnabled(db, "proj", true);

    // Add a row
    rowAdd(db, "proj", {
      feature: "my-feature",
      planFile: "plans/my-feature.md",
      stage: "review",
      branch: "autonomous/my-feature",
      targetBranch: "master",
      // Terminal case: review_retries == review_retry_budget so the new
      // budget-aware reaper parks instead of re-spawning. Within-budget
      // re-spawn is covered by reaper-review-retry.test.mjs.
      reviewRetries: 3,
      reviewRetryBudget: 3,
    });

    // Record a review session with a fake pid
    sessionRecordSpawn(db, {
      correlationId: "corr-review",
      project: "proj",
      feature: "my-feature",
      sessionType: "review",
      cwd: "/tmp/proj",
      sessionFile: "sessions/review-1.md",
      pid: 1,  // PID 1 is init, will be considered alive; we'll fake it differently below
    });

    // For testing: manually inject a dead pid that won't be found alive
    // We need to use a very high PID that's guaranteed to be dead
    db.prepare(
      "UPDATE sessions SET pid = ? WHERE correlation_id = ?"
    ).run(999999, "corr-review");

    const logFn = createMockLog();
    reconcileSessions(db, { logFn, dryRun: true });

    // Check that the row was parked at manual
    const row = rowGet(db, "proj", "my-feature");
    strictEqual(row.stage, "manual");
    ok(row.notes_extra.includes("review") || logFn.hasMessage("review"));
  } finally {
    cleanupDb(db, dbDir);
  }
});

// ── reconcileSessions: handoff recorded ───────────────────────────────────────

test("reconcileSessions skips reconcile if row already advanced past session stage", () => {
  const { db, dbDir } = initDb();
  const projDir = join(dbDir, "proj");
  try {
    initGitRepo(projDir);
    projectAdd(db, { name: "proj", rootPath: projDir });

    // Add a row that's already advanced past review
    rowAdd(db, "proj", {
      feature: "my-feature",
      planFile: "plans/my-feature.md",
      stage: "test",
      branch: "autonomous/my-feature",
      targetBranch: "master",
    });

    sessionRecordSpawn(db, {
      correlationId: "corr-review",
      project: "proj",
      feature: "my-feature",
      sessionType: "review",
      cwd: "/tmp/proj",
      sessionFile: "sessions/review.md",
      pid: 999999,  // Dead pid
    });

    const logFn = createMockLog();
    reconcileSessions(db, { logFn, dryRun: true });

    // Row should stay at test (no action taken)
    const row = rowGet(db, "proj", "my-feature");
    strictEqual(row.stage, "test");
    ok(logFn.hasMessage("row already at stage"));
  } finally {
    cleanupDb(db, dbDir);
  }
});

// ── reconcileSessions: dev no-handoff recovery ────────────────────────────────

test("reconcileSessions recovers dev with review_retries > 0 and budget remaining", () => {
  const { db, dbDir } = initDb();
  const projDir = join(dbDir, "proj");
  try {
    initGitRepo(projDir);
    projectAdd(db, { name: "proj", rootPath: projDir });

    // Add a dev row with retry budget
    rowAdd(db, "proj", {
      feature: "my-feature",
      planFile: "plans/my-feature.md",
      stage: "dev",
      branch: "autonomous/my-feature",
      targetBranch: "master",
      reviewRetries: 1,
      reviewRetryBudget: 3,
    });

    // Set notes_extra to type=dev so reconcile recognizes it
    rowUpdate(db, "proj", "my-feature", {
      notes_extra: "type=dev sessions/dev-1.md",
    });

    sessionRecordSpawn(db, {
      correlationId: "corr-dev",
      project: "proj",
      feature: "my-feature",
      sessionType: "dev",
      cwd: "/tmp/proj",
      sessionFile: "sessions/dev-1.md",
      pid: 999999,  // Dead pid
    });

    const logFn = createMockLog();
    reconcileSessions(db, { logFn, dryRun: true });

    // Row should advance directly to review (stage-driven spawn)
    const row = rowGet(db, "proj", "my-feature");
    strictEqual(row.stage, "review");
    ok(logFn.hasMessage("recoverable"));
  } finally {
    cleanupDb(db, dbDir);
  }
});

test("reconcileSessions parks dev with no retries remaining", () => {
  const { db, dbDir } = initDb();
  const projDir = join(dbDir, "proj");
  try {
    initGitRepo(projDir);
    projectAdd(db, { name: "proj", rootPath: projDir });

    // Add a dev row with no retries
    rowAdd(db, "proj", {
      feature: "my-feature",
      planFile: "plans/my-feature.md",
      stage: "dev",
      branch: "autonomous/my-feature",
      targetBranch: "master",
      reviewRetries: 0,
      reviewRetryBudget: 3,
    });

    // Set notes_extra to type=dev so reconcile recognizes it
    rowUpdate(db, "proj", "my-feature", {
      notes_extra: "type=dev sessions/dev-1.md",
    });

    sessionRecordSpawn(db, {
      correlationId: "corr-dev",
      project: "proj",
      feature: "my-feature",
      sessionType: "dev",
      cwd: "/tmp/proj",
      sessionFile: "sessions/dev-1.md",
      pid: 999999,  // Dead pid
    });

    const logFn = createMockLog();
    reconcileSessions(db, { logFn, dryRun: true });

    // Row should park at manual
    const row = rowGet(db, "proj", "my-feature");
    strictEqual(row.stage, "manual");
    ok(row.notes_extra.includes("dev-no-handoff"));
  } finally {
    cleanupDb(db, dbDir);
  }
});
