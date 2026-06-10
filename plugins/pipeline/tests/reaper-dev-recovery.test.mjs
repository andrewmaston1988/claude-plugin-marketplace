// Smoke 20 — reaper recovery for dev-no-handoff inside a recoverable
// review-bounce cycle. See reaper.mjs:180+ for the branch under test.
//
// Two cases:
//   (a) review_verdict=needs_work AND retries<budget → advance to review
//   (b) no review_verdict (initial dev) → park at manual

import { test } from "node:test";
import { strictEqual, ok, match } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdirSync } from "node:fs";
import { connectPath, close } from "../scripts/pipeline-db/connection.mjs";
import { projectAdd } from "../scripts/pipeline-db/projects.mjs";
import { rowAdd } from "../scripts/pipeline-db/rows.mjs";
import { reconcileSessions } from "../scripts/orchestrator/reaper.mjs";

// High PID value that is guaranteed not to be a live process on this machine
const DEAD_PID = 999999;

function seedDeadSession(db, { project, feature, correlationId = "test-corr" }) {
  // Insert a session with a dead PID so reconcileSessions will detect it as finished.
  db.prepare(
    "INSERT INTO sessions (correlation_id, project, feature, session_type, cwd, session_file, spawn_time, pid, is_active) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)"
  ).run(correlationId, project, feature, "dev", "/tmp", "sessions/dev.md", new Date().toISOString(), DEAD_PID);
}

function setupTempProject() {
  // Mirror parity-runner's temp project layout so generateSessionFile finds
  // the plan + a sessions dir to write into. projectAdd requires the path
  // to be a real git repo.
  const root = mkdtempSync(join(tmpdir(), "reaper-recovery-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const plans = join(root, "plans");
  mkdirSync(plans, { recursive: true });
  const planFile = join(plans, "feat-x.md");
  writeFileSync(planFile, "# Plan\n\nPlan body.\n");
  return { root, planFile };
}

test("reaper: dev-no-handoff inside review-bounce → recovers to review", () => {
  const { root, planFile } = setupTempProject();
  const dbPath = join(root, ".pipeline", "pipeline.db");
  const db = connectPath(dbPath);
  try {
    projectAdd(db, { name: "p", rootPath: root });
    rowAdd(db, "p", { feature: "feat-x", planFile, stage: "dev", branch: "autonomous/feat-x" });
    // Simulate the state after one review-bounce: stage=dev, type=dev in notes,
    // review_verdict=needs_work, retries=1 of 3.
    db.prepare(
      "UPDATE pipeline_rows SET notes_extra=?, review_verdict=?, review_retries=?, review_retry_budget=? " +
      "WHERE project=? AND feature=?"
    ).run("type=dev sessions/dev-2026-06-08-feat-x.md", "needs_work", 1, 3, "p", "feat-x");

    seedDeadSession(db, { project: "p", feature: "feat-x", correlationId: "test-corr-1" });
    const logs = [];
    const logFn = (msg, level) => logs.push({ msg, level: level || "INFO" });

    reconcileSessions(db, { logFn, dryRun: true });

    const row = db.prepare(
      "SELECT stage, notes_extra FROM pipeline_rows WHERE project=? AND feature=?"
    ).get("p", "feat-x");

    strictEqual(row.stage, "queued", "row should be requeued, not parked");
    match(row.notes_extra, /\btype=review\b/, "notes_extra should now route to review");
    match(row.notes_extra, /dev-no-handoff-recovered/, "notes_extra should carry an audit marker");
    ok(
      logs.some(l => l.msg.includes("advancing to review") && l.level === "WARN"),
      "should log the recovery decision at WARN"
    );
  } finally {
    close(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("reaper: dev-no-handoff with no review verdict (initial dev) → parks at manual", () => {
  const { root, planFile } = setupTempProject();
  const dbPath = join(root, ".pipeline", "pipeline.db");
  const db = connectPath(dbPath);
  try {
    projectAdd(db, { name: "p", rootPath: root });
    rowAdd(db, "p", { feature: "feat-x", planFile, stage: "dev", branch: "autonomous/feat-x" });
    // Fresh dev: no review_verdict, no retries — initial pass.
    db.prepare(
      "UPDATE pipeline_rows SET notes_extra=? WHERE project=? AND feature=?"
    ).run("type=dev sessions/dev-2026-06-08-feat-x.md", "p", "feat-x");

    seedDeadSession(db, { project: "p", feature: "feat-x", correlationId: "test-corr-2" });
    const logs = [];
    const logFn = (msg, level) => logs.push({ msg, level: level || "INFO" });

    reconcileSessions(db, { logFn, dryRun: true });

    const row = db.prepare(
      "SELECT stage, notes_extra FROM pipeline_rows WHERE project=? AND feature=?"
    ).get("p", "feat-x");

    strictEqual(row.stage, "manual", "fresh dev no-handoff should park (no recovery context)");
    match(row.notes_extra, /dev-no-handoff/, "should carry the dev-no-handoff annotation");
    ok(!/recovered/.test(row.notes_extra), "should NOT carry the recovery marker");
  } finally {
    close(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("reaper: dev-no-handoff with needs_work but budget exhausted → parks at manual", () => {
  const { root, planFile } = setupTempProject();
  const dbPath = join(root, ".pipeline", "pipeline.db");
  const db = connectPath(dbPath);
  try {
    projectAdd(db, { name: "p", rootPath: root });
    rowAdd(db, "p", { feature: "feat-x", planFile, stage: "dev", branch: "autonomous/feat-x" });
    // Budget exhausted: retries == budget.
    db.prepare(
      "UPDATE pipeline_rows SET notes_extra=?, review_verdict=?, review_retries=?, review_retry_budget=? " +
      "WHERE project=? AND feature=?"
    ).run("type=dev sessions/dev-2026-06-08-feat-x.md", "needs_work", 3, 3, "p", "feat-x");

    seedDeadSession(db, { project: "p", feature: "feat-x", correlationId: "test-corr-3" });
    const logs = [];
    const logFn = (msg, level) => logs.push({ msg, level: level || "INFO" });

    reconcileSessions(db, { logFn, dryRun: true });

    const row = db.prepare(
      "SELECT stage, notes_extra FROM pipeline_rows WHERE project=? AND feature=?"
    ).get("p", "feat-x");

    strictEqual(row.stage, "manual", "exhausted budget should park, not recover");
    match(row.notes_extra, /dev-no-handoff/);
    ok(!/recovered/.test(row.notes_extra), "no recovery marker once budget is exhausted");
  } finally {
    close(db);
    rmSync(root, { recursive: true, force: true });
  }
});
