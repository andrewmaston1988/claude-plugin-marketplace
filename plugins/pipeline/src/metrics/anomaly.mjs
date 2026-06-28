// Anomaly detection: z-score on token rate + cold-cache R/C ratio checks.
import { mkdirSync, existsSync, statSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { loadMetricSessions } from "../db/index.mjs";
import { parseTimestamp } from "./sessions.mjs";
import { loadBaseline } from "./baselines.mjs";
import { getCcusageSessionData } from "./ccusage.mjs";

/**
 * detect-anomalies: flag sessions from past 24h against baseline z-scores.
 * Appends to cache_alerts.md in alertsDir.
 */
export function detectAnomalies(db, baselineDir, alertsDir) {
  const baselineData = loadBaseline(baselineDir);
  if (!baselineData) {
    process.stdout.write("Baseline file not found. Run update-sessions and update-baselines first.\n");
    return;
  }
  const baselines = baselineData.baselines ?? {};

  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const allSessions = loadMetricSessions(db);
  const recentSessions = allSessions.filter(s => {
    const ts = parseTimestamp(s.timestamp);
    return ts && ts >= cutoff;
  });

  process.stdout.write(`Checking ${recentSessions.length} recent sessions for anomalies\n`);

  const alerts = [];
  for (const session of recentSessions) {
    if ((session.duration_seconds ?? 0) < 30) continue;
    const cmdType = session.command_type;
    if (!cmdType || !baselines[cmdType]) continue;
    const bl = baselines[cmdType];
    if (bl.sessions_count === 0) continue;

    const durationMin = (session.duration_seconds ?? 0) / 60;
    const actualPerMin = (session.cache_create_tokens ?? 0) / durationMin;

    const z = bl.stddev_create_per_min === 0
      ? 0
      : (actualPerMin - bl.avg_create_per_min) / bl.stddev_create_per_min;

    let actualRatio = session.cache_read_ratio ?? null;
    if (actualRatio === null && (session.cache_create_tokens ?? 0) > 0) {
      actualRatio = (session.cache_read_tokens ?? 0) / session.cache_create_tokens;
    }
    const baselineRatio = bl.avg_read_ratio ?? 0;
    const stddevRatio   = bl.stddev_read_ratio ?? 0;
    const isColdCache = (
      actualRatio !== null &&
      actualRatio > 0 &&
      (actualRatio < 5 || (stddevRatio > 0 && (actualRatio - baselineRatio) / stddevRatio < -2.0))
    );
    const isRateAnomaly = Math.abs(z) > 2.5;

    let severity;
    if (Math.abs(z) > 4.0)    severity = "critical";
    else if (Math.abs(z) > 2.5) severity = "high";
    else if (isColdCache)       severity = "cold_cache";
    else                        severity = "normal";

    if (isRateAnomaly || isColdCache) {
      alerts.push({
        session_id:       session.session_id,
        timestamp:        session.timestamp,
        z_score:          Math.round(z * 100) / 100,
        severity,
        command_type:     cmdType,
        actual_per_min:   Math.trunc(actualPerMin),
        baseline_per_min: bl.avg_create_per_min,
        stddev:           bl.stddev_create_per_min,
        cache_read_ratio: actualRatio !== null ? Math.round(actualRatio * 10) / 10 : null,
        baseline_read_ratio: Math.round(baselineRatio * 10) / 10,
      });
    }
  }

  if (alerts.length) {
    mkdirSync(alertsDir, { recursive: true });
    const alertsPath = join(alertsDir, "cache_alerts.md");
    const isEmpty = !existsSync(alertsPath) || statSync(alertsPath).size === 0;
    let out = "";
    if (isEmpty) out += "# Cache Anomaly Alerts\n\n";
    const dateStr = now.toISOString().slice(0, 10);
    out += `## ${dateStr}\n\n`;
    for (const alert of alerts) {
      out += `### Anomaly: ${alert.severity.charAt(0).toUpperCase() + alert.severity.slice(1)} (z=${alert.z_score})\n`;
      out += `- Session: ${alert.session_id}\n`;
      out += `- Command: ${alert.command_type}\n`;
      out += `- Actual: ${alert.actual_per_min}k CREATE/min (baseline: ${alert.baseline_per_min}k ± ${alert.stddev}k)\n`;
      if (alert.cache_read_ratio !== null) {
        out += `- R/C ratio: ${alert.cache_read_ratio}x (baseline: ${alert.baseline_read_ratio}x)\n`;
      }
      out += `- Timestamp: ${alert.timestamp}\n\n`;
    }
    appendFileSync(alertsPath, out, "utf8");
    process.stdout.write(`Logged ${alerts.length} anomalies\n`);
  } else {
    process.stdout.write("No anomalies detected\n");
  }
}

/**
 * per-session-anomaly: detect sessions >2× median cost for a date via ccusage session data.
 * Prints JSON to stdout.
 */
export async function perSessionAnomaly(dateStr) {
  const sessions = await getCcusageSessionData(dateStr);
  if (!sessions) {
    process.stdout.write(`No sessions found for ${dateStr}\n`);
    return true;
  }

  const costs = sessions.map(s => s.totalCost ?? 0);
  if (!costs.length) {
    process.stdout.write("No cost data in session records\n");
    return true;
  }

  const sorted = [...costs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianCost = sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
  const costThreshold = medianCost * 2;

  const COLD_CACHE_RATIO    = 5.0;
  const COLD_CACHE_MIN_COST = 0.50;

  const anomalies = [];
  for (const session of sessions) {
    const cost   = session.totalCost ?? 0;
    const create = session.cacheCreationTokens ?? 0;
    const read   = session.cacheReadTokens ?? 0;
    const rcRatio = create > 0 ? read / create : null;

    const isCostAnomaly = cost > costThreshold;
    const isColdCache = rcRatio !== null && rcRatio < COLD_CACHE_RATIO && cost > COLD_CACHE_MIN_COST;

    if (isCostAnomaly || isColdCache) {
      anomalies.push({
        session_id:          session.sessionId ?? "unknown",
        models_used:         session.modelsUsed ?? [],
        cost:                Math.round(cost * 10000) / 10000,
        cost_ratio:          medianCost > 0 ? Math.round(cost / medianCost * 100) / 100 : 0,
        cache_create_tokens: create,
        cache_read_tokens:   read,
        rc_ratio:            rcRatio !== null ? Math.round(rcRatio * 10) / 10 : null,
        flags: [
          ...(isCostAnomaly ? ["high_cost"]  : []),
          ...(isColdCache   ? ["cold_cache"] : []),
        ],
      });
    }
  }

  const output = {
    date:           dateStr,
    median_cost:    Math.round(medianCost * 10000) / 10000,
    cost_threshold: Math.round(costThreshold * 10000) / 10000,
    total_sessions: sessions.length,
    anomaly_count:  anomalies.length,
    anomalies,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  return true;
}

/**
 * Detect anomalies in a list of sessions (inline, for report generation).
 * Returns array of anomaly objects.
 */
export function detectSessionAnomalies(sessionsInWindow, baselines) {
  const anomalies = [];
  for (const session of sessionsInWindow) {
    if ((session.duration_seconds ?? 0) < 30) continue;
    const cmdType = session.command_type;
    if (!cmdType || !baselines[cmdType] || baselines[cmdType].sessions_count === 0) continue;
    const bl = baselines[cmdType];
    const durationMin = (session.duration_seconds ?? 0) / 60;
    const actualPerMin = (session.cache_create_tokens ?? 0) / durationMin;
    const stddev = bl.stddev_create_per_min;
    const z = stddev ? (actualPerMin - bl.avg_create_per_min) / stddev : 0;
    if (Math.abs(z) > 2.5) {
      anomalies.push({
        session_id:      session.session_id,
        command_type:    cmdType,
        z_score:         z,
        actual_per_min:  actualPerMin,
        baseline_per_min: bl.avg_create_per_min,
        duration_sec:    session.duration_seconds,
      });
    }
  }
  return anomalies;
}
