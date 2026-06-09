// smoke-15: governor revival — cfg-gating + scheduling logic.
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
