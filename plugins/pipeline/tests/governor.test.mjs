// governor revival — cfg-gating + scheduling logic.
//
// Covers the pieces of governor.mjs that don't actually spawn a subprocess:
// context resolution, report-presence checks, and shouldSpawn* timing logic
// with injected Date.
import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectPath, close, projectAdd, appendGovernorSpawn } from "../scripts/pipeline-db/index.mjs";
import {
  resolveGovernorContext,
  shouldSpawnGovernor,
  shouldSpawnMonthlyGovernor,
} from "../scripts/orchestrator/governor.mjs";

const PROJECT = "testproject";

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "smoke15-"));
  const dbPath = join(tmp, "pipeline.db");
  const root = join(tmp, "myproj");
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(dbPath);
  projectAdd(db, { name: PROJECT, rootPath: root });
  return { tmp, db, root };
}

function teardown(tmp, db) {
  try { close(db); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

// ── resolveGovernorContext ───────────────────────────────────────────────────

test("resolveGovernorContext: null when governor.enabled is false (default)", () => {
  const { tmp, db } = setup();
  try {
    equal(resolveGovernorContext(db, { governor: { enabled: false } }), null);
  } finally { teardown(tmp, db); }
});

test("resolveGovernorContext: null when project not specified", () => {
  const { tmp, db } = setup();
  try {
    equal(resolveGovernorContext(db, { governor: { enabled: true, project: null } }), null);
  } finally { teardown(tmp, db); }
});

test("resolveGovernorContext: null when project not registered", () => {
  const { tmp, db } = setup();
  try {
    const cfg = { governor: { enabled: true, project: "ghost" }, models: {} };
    equal(resolveGovernorContext(db, cfg), null);
  } finally { teardown(tmp, db); }
});

test("resolveGovernorContext: returns derived paths from projectRoot when defaults apply", () => {
  const { tmp, db, root } = setup();
  try {
    const cfg = {
      governor: { enabled: true, project: PROJECT,
                  template_path: null, reports_dir: null, session_dir: null, log_dir: null },
      models:   { governor: "claude-sonnet-4-6" },
    };
    const ctx = resolveGovernorContext(db, cfg);
    ok(ctx, "expected non-null context");
    equal(ctx.projectName, PROJECT);
    equal(ctx.projectRoot, root);
    equal(ctx.reportsDir, join(root, "reports"));
    equal(ctx.sessionDir, join(root, "sessions"));
    equal(ctx.logDir,     join(root, "logs"));
    equal(ctx.govModel,   "claude-sonnet-4-6");
    ok(ctx.templatePath.endsWith("governor-session.md"));
  } finally { teardown(tmp, db); }
});

test("resolveGovernorContext: honours explicit overrides", () => {
  const { tmp, db } = setup();
  try {
    const cfg = {
      governor: {
        enabled: true, project: PROJECT,
        template_path: "/tmp/my-template.md",
        reports_dir:   "/tmp/r",
        session_dir:   "/tmp/s",
        log_dir:       "/tmp/l",
      },
      models: { governor: "claude-haiku-4-5" },
    };
    const ctx = resolveGovernorContext(db, cfg);
    equal(ctx.templatePath, "/tmp/my-template.md");
    equal(ctx.reportsDir,   "/tmp/r");
    equal(ctx.sessionDir,   "/tmp/s");
    equal(ctx.logDir,       "/tmp/l");
    equal(ctx.govModel,     "claude-haiku-4-5");
  } finally { teardown(tmp, db); }
});

// ── shouldSpawnGovernor — timing logic ───────────────────────────────────────

test("shouldSpawnGovernor: triggers at 00:01 UTC for daily 'full' report", () => {
  const { tmp, db } = setup();
  try {
    const reportsDir = join(tmp, "reports-dir");
    mkdirSync(reportsDir, { recursive: true });
    // At 00:05 UTC with no prior governor spawn and no yesterday report
    const now = new Date("2026-06-08T00:05:00Z");
    const result = shouldSpawnGovernor(reportsDir, db, now);
    equal(result.should, true);
    equal(result.reportType, "full");
    equal(result.slotHour, 0);
  } finally { teardown(tmp, db); }
});

test("shouldSpawnGovernor: triggers at 12:01 UTC for 'status' report", () => {
  const { tmp, db } = setup();
  try {
    const reportsDir = join(tmp, "reports-dir");
    mkdirSync(reportsDir, { recursive: true });
    // Ensure yesterday's full report exists so catch-up doesn't trigger first
    const yest = new Date("2026-06-08T12:05:00Z");
    yest.setUTCDate(yest.getUTCDate() - 1);
    const yStr = yest.toISOString().slice(0, 10).replace(/-/g, "");
    writeFileSync(join(reportsDir, `governance-${yStr}.md`), "stub", "utf8");
    // At 12:05 UTC with 06:00 status report present (so catch-up for 6 misses)
    const tStr = "20260608";
    writeFileSync(join(reportsDir, `status-${tStr}.md`), "stub", "utf8");
    // Note: catch-up checks 18, 12, 6 in order; 12 has a report so it skips,
    // 6 has the same file. Canonical at 12:05 should still fire status.
    const now = new Date("2026-06-08T12:05:00Z");
    const result = shouldSpawnGovernor(reportsDir, db, now);
    // Catch-up loop checks slots in order [18, 12, 6]; 18 is in the future
    // (h===12, 12 >= 18 is false), 12 has a report (skip), 6 has same file
    // (skip, mtime check passes because mtime > slot-fire-time of 6).
    // Then canonical hits h===12,m===5 → status, slot 12. But it also
    // checks if "last spawn was today" — none, so should=true.
    equal(result.reportType, "status");
    equal(result.slotHour, 12);
  } finally { teardown(tmp, db); }
});

test("shouldSpawnGovernor: no spawn at 03:00 UTC outside any window", () => {
  const { tmp, db } = setup();
  try {
    const reportsDir = join(tmp, "reports-dir");
    mkdirSync(reportsDir, { recursive: true });
    // Ensure yesterday's report exists so catch-up doesn't fire
    const yest = new Date("2026-06-08T03:00:00Z");
    yest.setUTCDate(yest.getUTCDate() - 1);
    const yStr = yest.toISOString().slice(0, 10).replace(/-/g, "");
    writeFileSync(join(reportsDir, `governance-${yStr}.md`), "stub", "utf8");
    // 03:00 is not in any canonical slot and 6/12/18 are all in future
    const now = new Date("2026-06-08T03:00:00Z");
    const result = shouldSpawnGovernor(reportsDir, db, now);
    equal(result.should, false);
  } finally { teardown(tmp, db); }
});

// ── shouldSpawnMonthlyGovernor ───────────────────────────────────────────────

test("shouldSpawnMonthlyGovernor: false when not first of month", () => {
  const { tmp, db } = setup();
  try {
    equal(shouldSpawnMonthlyGovernor(db, new Date("2026-06-15T00:05:00Z")), false);
  } finally { teardown(tmp, db); }
});

test("shouldSpawnMonthlyGovernor: false when first of month but not 00:01 UTC", () => {
  const { tmp, db } = setup();
  try {
    equal(shouldSpawnMonthlyGovernor(db, new Date("2026-06-01T05:30:00Z")), false);
  } finally { teardown(tmp, db); }
});

test("shouldSpawnMonthlyGovernor: true when first of month at 00:01+ UTC and no prior", () => {
  const { tmp, db } = setup();
  try {
    equal(shouldSpawnMonthlyGovernor(db, new Date("2026-06-01T00:05:00Z")), true);
  } finally { teardown(tmp, db); }
});

// ── Global cooldown guard ─────────────────────────────────────────────────────

test("shouldSpawnGovernor: cooldown blocks spawn within 5 minutes of last spawn", () => {
  const { tmp, db } = setup();
  try {
    const reportsDir = join(tmp, "reports");
    mkdirSync(reportsDir, { recursive: true });
    // Seed yesterday's report so catch-up for slot 0 doesn't fire
    const now = new Date("2026-06-08T12:05:00Z");
    const yest = new Date(now); yest.setUTCDate(now.getUTCDate() - 1);
    const yStr = yest.toISOString().slice(0, 10).replace(/-/g, "");
    writeFileSync(join(reportsDir, `governance-${yStr}.md`), "stub", "utf8");
    // Also seed today's status reports so no catch-up fires for 6
    writeFileSync(join(reportsDir, `status-20260608.md`), "stub", "utf8");
    // Record a governor spawn 2 minutes ago (well within 5m cooldown)
    const twoMinsAgo = new Date(now.getTime() - 2 * 60 * 1000);
    appendGovernorSpawn(db, { slot_hour: 0, spawn_time: twoMinsAgo.toISOString(), corr_id: "test-1", report_type: "full" });
    const result = shouldSpawnGovernor(reportsDir, db, now);
    equal(result.should, false, "cooldown should block spawn within 5 minutes");
    equal(result.skippedReason, "cooldown");
  } finally { teardown(tmp, db); }
});

test("shouldSpawnGovernor: cooldown does not block after 5+ minutes", () => {
  const { tmp, db } = setup();
  try {
    const reportsDir = join(tmp, "reports");
    mkdirSync(reportsDir, { recursive: true });
    // At canonical slot 12:05, ensure conditions for a valid spawn
    const now = new Date("2026-06-08T12:05:00Z");
    const yest = new Date(now); yest.setUTCDate(now.getUTCDate() - 1);
    const yStr = yest.toISOString().slice(0, 10).replace(/-/g, "");
    writeFileSync(join(reportsDir, `governance-${yStr}.md`), "stub", "utf8");
    writeFileSync(join(reportsDir, `status-20260608.md`), "stub", "utf8");
    // Record a spawn 6 minutes ago (past the 5m cooldown)
    const sixMinsAgo = new Date(now.getTime() - 6 * 60 * 1000);
    appendGovernorSpawn(db, { slot_hour: 0, spawn_time: sixMinsAgo.toISOString(), corr_id: "test-2", report_type: "full" });
    const result = shouldSpawnGovernor(reportsDir, db, now);
    // Cooldown expired — normal logic applies; at 12:05 canonical slot fires
    equal(result.should, true, "cooldown should not block after 5+ minutes");
    equal(result.skippedReason, undefined);
  } finally { teardown(tmp, db); }
});

test("shouldSpawnGovernor: no cooldown when no prior spawn exists", () => {
  const { tmp, db } = setup();
  try {
    const reportsDir = join(tmp, "reports");
    mkdirSync(reportsDir, { recursive: true });
    const now = new Date("2026-06-08T00:05:00Z");
    // No prior spawn recorded — cooldown should be a no-op
    const result = shouldSpawnGovernor(reportsDir, db, now);
    equal(result.should, true, "no prior spawn means no cooldown, full report should fire");
  } finally { teardown(tmp, db); }
});

test("shouldSpawnGovernor: cooldown blocks second slot after cascade scenario", () => {
  // Simulates the incident: empty reports dir → slot 0 fires → 30s later slot 18 would fire.
  // After slot 0 spawn is recorded, the 5m cooldown should suppress slot 18.
  const { tmp, db } = setup();
  try {
    const reportsDir = join(tmp, "reports");
    mkdirSync(reportsDir, { recursive: true });
    // 30 seconds after slot 0 fired, at 18:xx UTC — all slots have missing reports
    const now = new Date("2026-06-08T18:01:30Z");
    // Slot 0 fired 30 seconds ago
    const thirtySecsAgo = new Date(now.getTime() - 30 * 1000);
    appendGovernorSpawn(db, { slot_hour: 0, spawn_time: thirtySecsAgo.toISOString(), corr_id: "cascade-0", report_type: "full" });
    const result = shouldSpawnGovernor(reportsDir, db, now);
    equal(result.should, false, "slot 18 should be suppressed by cooldown 30s after slot 0");
    equal(result.skippedReason, "cooldown");
  } finally { teardown(tmp, db); }
});

// ── Cross-day boundary tests for shouldSpawnGovernor ─────────────────────────
// These cover the scheduling change: catch-up retries only when last attempt
// was yesterday (not 2+ days ago); status slots only retry on cross-day boundary.

test("shouldSpawnGovernor: catch-up fires when last attempt was yesterday and ≥1h ago", () => {
  // Yesterday's full report missing; last spawn was yesterday 26h ago — cross-day retry allowed.
  const { tmp, db } = setup();
  try {
    const reportsDir = join(tmp, "reports");
    mkdirSync(reportsDir, { recursive: true });
    const now = new Date("2026-06-09T10:00:00Z");
    // Last spawn for slot 0 was yesterday at 08:00 (26h before now, well past cooldown)
    appendGovernorSpawn(db, { slot_hour: 0, spawn_time: "2026-06-08T08:00:00Z", corr_id: "xday-1", report_type: "full" });
    // Yesterday's governance report still missing
    const result = shouldSpawnGovernor(reportsDir, db, now);
    equal(result.should, true, "cross-day retry: yesterday attempt + report missing should fire");
    equal(result.reportType, "full");
    equal(result.slotHour, 0);
  } finally { teardown(tmp, db); }
});

test("shouldSpawnGovernor: catch-up suppressed when last attempt was today", () => {
  // Yesterday's full report missing; last slot-0 spawn was TODAY — same-day suppression.
  const { tmp, db } = setup();
  try {
    const reportsDir = join(tmp, "reports");
    mkdirSync(reportsDir, { recursive: true });
    const now = new Date("2026-06-09T10:00:00Z");
    // Slot 0 already attempted today (30 min ago, past cooldown)
    appendGovernorSpawn(db, { slot_hour: 0, spawn_time: "2026-06-09T09:30:00Z", corr_id: "same-day-0", report_type: "full" });
    // Write today's status-6 report so the status catch-up loop doesn't fire
    writeFileSync(join(reportsDir, "status-20260609.md"), "stub", "utf8");
    // Also add a today spawn for slot 6 to satisfy the status loop's date check
    appendGovernorSpawn(db, { slot_hour: 6, spawn_time: "2026-06-09T06:05:00Z", corr_id: "same-day-6", report_type: "status" });
    const result = shouldSpawnGovernor(reportsDir, db, now);
    equal(result.should, false, "same-day catch-up suppression: already tried today, no retry");
  } finally { teardown(tmp, db); }
});

test("shouldSpawnGovernor: catch-up suppressed when last attempt was two days ago", () => {
  // Yesterday's full report missing; last spawn was 2 days ago — only yesterday-dated retries allowed.
  const { tmp, db } = setup();
  try {
    const reportsDir = join(tmp, "reports");
    mkdirSync(reportsDir, { recursive: true });
    const now = new Date("2026-06-09T10:00:00Z");
    // Last spawn for slot 0 was 2 days ago (lastDs = "20260607" ≠ yesterday "20260608")
    appendGovernorSpawn(db, { slot_hour: 0, spawn_time: "2026-06-07T08:00:00Z", corr_id: "two-days-ago", report_type: "full" });
    // Write status-6 report so status loop doesn't fire
    writeFileSync(join(reportsDir, "status-20260609.md"), "stub", "utf8");
    appendGovernorSpawn(db, { slot_hour: 6, spawn_time: "2026-06-09T06:05:00Z", corr_id: "two-days-6", report_type: "status" });
    const result = shouldSpawnGovernor(reportsDir, db, now);
    equal(result.should, false, "catch-up only allows one retry when lastDs === yesterday; two-days-ago must not retry");
  } finally { teardown(tmp, db); }
});

test("shouldSpawnGovernor: status catch-up fires when last attempt was yesterday", () => {
  // Yesterday's full report present; today's slot-6 status missing; last slot-6 spawn was yesterday.
  const { tmp, db } = setup();
  try {
    const reportsDir = join(tmp, "reports");
    mkdirSync(reportsDir, { recursive: true });
    const now = new Date("2026-06-09T10:00:00Z");
    // Yesterday's full report present (suppresses full catch-up)
    writeFileSync(join(reportsDir, "governance-20260608.md"), "stub", "utf8");
    // Last slot-6 spawn was yesterday (cross-day: lastDs "20260608" ≠ today "20260609")
    appendGovernorSpawn(db, { slot_hour: 6, spawn_time: "2026-06-08T06:05:00Z", corr_id: "status-xday", report_type: "status" });
    // Today's status-6 report NOT written → governorReportPresent returns false for slot 6
    const result = shouldSpawnGovernor(reportsDir, db, now);
    equal(result.should, true, "status catch-up should fire when last spawn was yesterday");
    equal(result.reportType, "status");
    equal(result.slotHour, 6);
  } finally { teardown(tmp, db); }
});

test("shouldSpawnGovernor: status catch-up suppressed when already attempted today", () => {
  // Yesterday's full report present; today's slot-6 status missing; last slot-6 spawn was today.
  const { tmp, db } = setup();
  try {
    const reportsDir = join(tmp, "reports");
    mkdirSync(reportsDir, { recursive: true });
    const now = new Date("2026-06-09T10:00:00Z");
    // Yesterday's full report present (suppresses full catch-up)
    writeFileSync(join(reportsDir, "governance-20260608.md"), "stub", "utf8");
    // Last slot-6 spawn was today (lastDs "20260609" === today "20260609")
    appendGovernorSpawn(db, { slot_hour: 6, spawn_time: "2026-06-09T06:05:00Z", corr_id: "status-today", report_type: "status" });
    // Today's status-6 report NOT written → file missing, but spawn was today → suppressed
    const result = shouldSpawnGovernor(reportsDir, db, now);
    // At 10:00 UTC: slot 12 and 18 are in the future; slot 6 suppressed; canonical h=10 doesn't match
    equal(result.should, false, "status same-day suppression: already spawned today, no retry");
  } finally { teardown(tmp, db); }
});
