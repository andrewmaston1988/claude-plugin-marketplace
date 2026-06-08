#!/usr/bin/env node
// Metrics CLI — spend analytics and governance reporting.
// Mirrors cache_metrics.py subcommand surface (CLAUDE-side functions dropped).
import { join } from "node:path";
import { homedir } from "node:os";
import { connectPath } from "../pipeline-db/index.mjs";
import { updateSpend, computeMonthlyMetrics } from "./spend.mjs";
import { updateSessions, updateSessionsFromProjects } from "./sessions.mjs";
import { updateBaselines } from "./baselines.mjs";
import { detectAnomalies, perSessionAnomaly } from "./anomaly.mjs";
import { generateReport, generateStatusReport } from "./report.mjs";
import { publishReport } from "../publisher.mjs";

// Resolve pipeline.db — env override, then default ~/.pipeline/pipeline.db.
function resolveDbPath() {
  if (process.env.PIPELINE_DB) return process.env.PIPELINE_DB;
  return join(homedir(), ".pipeline", "pipeline.db");
}

// Resolve reports directory — env override, then default ~/.pipeline/reports.
function resolveReportsDir() {
  return process.env.PIPELINE_REPORTS_DIR ?? join(homedir(), ".pipeline", "reports");
}

// Resolve baseline directory — env override, then default ~/.pipeline/baselines.
function resolveBaselineDir() {
  return process.env.PIPELINE_BASELINE_DIR ?? join(homedir(), ".pipeline", "baselines");
}

// Resolve alerts directory — env override, then default ~/.pipeline/memory.
function resolveAlertsDir() {
  return process.env.PIPELINE_ALERTS_DIR ?? join(homedir(), ".pipeline", "memory");
}

(async () => {
  const [,, cmd, ...rest] = process.argv;

  if (!cmd || cmd === "--help" || cmd === "-h") {
    process.stderr.write([
      "Usage: metrics <command> [args]",
      "Commands:",
      "  update-spend <YYYYMMDD> [--dry-run]",
      "  update-sessions",
      "  update-sessions-projects",
      "  update-baselines",
      "  detect-anomalies",
      "  generate-report <YYYYMMDD> [--rolling]",
      "  generate-status-report <YYYYMMDD>",
      "  monthly-metrics <YYYYMM>",
      "  post-report <file> [--dry-run]",
      "  per-session-anomaly <YYYYMMDD>",
      "",
    ].join("\n"));
    process.exit(0);
    return;
  }

  if (cmd === "update-spend") {
    const dateStr = rest[0];
    if (!dateStr || !/^\d{8}$/.test(dateStr)) {
      process.stderr.write("Usage: metrics update-spend YYYYMMDD [--dry-run]\n");
      setTimeout(() => process.exit(1), 150);
      return;
    }
    const dryRun = rest.includes("--dry-run");
    const db = connectPath(resolveDbPath());
    try { await updateSpend(db, dateStr, dryRun); }
    finally { db.close(); }
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (cmd === "update-sessions") {
    const db = connectPath(resolveDbPath());
    try { updateSessions(db); updateSessionsFromProjects(db); }
    finally { db.close(); }
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (cmd === "update-sessions-projects") {
    const db = connectPath(resolveDbPath());
    try { updateSessionsFromProjects(db); }
    finally { db.close(); }
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (cmd === "update-baselines") {
    const db = connectPath(resolveDbPath());
    try { updateBaselines(db, resolveBaselineDir()); }
    finally { db.close(); }
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (cmd === "detect-anomalies") {
    const db = connectPath(resolveDbPath());
    try { detectAnomalies(db, resolveBaselineDir(), resolveAlertsDir()); }
    finally { db.close(); }
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (cmd === "generate-report") {
    const dateStr = rest[0];
    if (!dateStr || !/^\d{8}$/.test(dateStr)) {
      process.stderr.write("Usage: metrics generate-report YYYYMMDD [--rolling]\n");
      setTimeout(() => process.exit(1), 150);
      return;
    }
    const rolling = rest.includes("--rolling");
    const db = connectPath(resolveDbPath());
    let ok;
    try {
      ok = await generateReport(db, dateStr, {
        reportsDir:  resolveReportsDir(),
        baselineDir: resolveBaselineDir(),
        rolling,
      });
    } finally { db.close(); }
    setTimeout(() => process.exit(ok ? 0 : 1), 150);
    return;
  }

  if (cmd === "generate-status-report") {
    const dateStr = rest[0];
    if (!dateStr || !/^\d{8}$/.test(dateStr)) {
      process.stderr.write("Usage: metrics generate-status-report YYYYMMDD\n");
      setTimeout(() => process.exit(1), 150);
      return;
    }
    const db = connectPath(resolveDbPath());
    try { await generateStatusReport(db, dateStr, { reportsDir: resolveReportsDir() }); }
    finally { db.close(); }
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (cmd === "monthly-metrics") {
    const monthStr = rest[0];
    if (!monthStr || !/^\d{6}$/.test(monthStr)) {
      process.stderr.write("Usage: metrics monthly-metrics YYYYMM\n");
      setTimeout(() => process.exit(1), 150);
      return;
    }
    const db = connectPath(resolveDbPath());
    let metrics;
    try { metrics = computeMonthlyMetrics(db, monthStr); }
    finally { db.close(); }
    if (!metrics) { setTimeout(() => process.exit(1), 150); return; }
    process.stdout.write(JSON.stringify(metrics, null, 2) + "\n");
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (cmd === "post-report") {
    const reportFile = rest[0];
    if (!reportFile) {
      process.stderr.write("Usage: metrics post-report <file> [--dry-run]\n");
      setTimeout(() => process.exit(1), 150);
      return;
    }
    const dryRun = rest.slice(1).includes("--dry-run");
    const ok = await publishReport(reportFile, { dryRun });
    setTimeout(() => process.exit(ok ? 0 : 1), 150);
    return;
  }

  if (cmd === "per-session-anomaly") {
    const dateStr = rest[0];
    if (!dateStr || !/^\d{8}$/.test(dateStr)) {
      process.stderr.write("Usage: metrics per-session-anomaly YYYYMMDD\n");
      setTimeout(() => process.exit(1), 150);
      return;
    }
    const ok = await perSessionAnomaly(dateStr);
    setTimeout(() => process.exit(ok ? 0 : 1), 150);
    return;
  }

  process.stderr.write(`Unknown command: ${cmd}\n`);
  setTimeout(() => process.exit(1), 150);

})().catch(e => {
  process.stderr.write((e?.message ?? String(e)) + "\n");
  setTimeout(() => process.exit(1), 150);
});
