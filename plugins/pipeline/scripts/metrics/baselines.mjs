// Baseline computation: 7-day rolling averages per command type.
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { loadMetricSessions } from "../pipeline-db/index.mjs";
import { parseTimestamp, getAllCommandTypes } from "./sessions.mjs";

const COMMAND_TYPES = getAllCommandTypes();

function stdev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function percentile(sorted, pct) {
  if (!sorted.length) return 0;
  const idx = Math.max(0, Math.trunc(sorted.length * pct) - 1);
  return sorted[idx];
}

/**
 * Calculate 7-day rolling baselines from metric_sessions in DB.
 * Writes cache_baseline.json and appends a snapshot to cache_baseline_history.jsonl.
 * @param {object} db - pipeline.db connection
 * @param {string} baselineDir - directory for baseline files (config.baselineDir)
 */
export function updateBaselines(db, baselineDir) {
  const sessions = loadMetricSessions(db);

  if (!sessions.length) {
    process.stdout.write("No metric_sessions found in DB. Run update-sessions first.\n");
    return;
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const filtered = sessions.filter(s => {
    if ((s.duration_seconds ?? 0) < 30) return false;
    const ts = parseTimestamp(s.timestamp);
    return ts && ts >= cutoff;
  });

  process.stdout.write(`Processing ${filtered.length} sessions from past 7 days (duration >= 30s)\n`);

  const byCommand = {};
  for (const s of filtered) {
    const cmd = s.command_type ?? "unknown";
    (byCommand[cmd] = byCommand[cmd] ?? []).push(s);
  }

  const baselines = {};
  for (const cmdType of COMMAND_TYPES) {
    const sessionsForType = byCommand[cmdType] ?? [];
    if (!sessionsForType.length) {
      baselines[cmdType] = {
        sessions_count: 0,
        avg_duration_sec: 0,
        avg_create_per_min: 0,
        stddev_create_per_min: 0,
        avg_read_per_min: 0,
        stddev_read_per_min: 0,
        p50_create_per_min: 0,
        p95_create_per_min: 0,
        avg_read_ratio: 0,
        stddev_read_ratio: 0,
      };
      continue;
    }

    const createPerMinList = [], readPerMinList = [], durationList = [], readRatioList = [];
    for (const s of sessionsForType) {
      const durationMin = (s.duration_seconds ?? 0) / 60;
      if (durationMin > 0) {
        createPerMinList.push((s.cache_create_tokens ?? 0) / durationMin);
        readPerMinList.push((s.cache_read_tokens ?? 0) / durationMin);
        durationList.push(s.duration_seconds ?? 0);
      }
      let ratio = s.cache_read_ratio ?? null;
      if (ratio === null && (s.cache_create_tokens ?? 0) > 0) {
        ratio = (s.cache_read_tokens ?? 0) / s.cache_create_tokens;
      }
      if (ratio !== null && ratio > 0) readRatioList.push(ratio);
    }

    createPerMinList.sort((a, b) => a - b);
    readPerMinList.sort((a, b) => a - b);

    const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    baselines[cmdType] = {
      sessions_count:        sessionsForType.length,
      avg_duration_sec:      Math.trunc(mean(durationList)),
      avg_create_per_min:    Math.trunc(mean(createPerMinList)),
      stddev_create_per_min: Math.trunc(stdev(createPerMinList)),
      avg_read_per_min:      Math.trunc(mean(readPerMinList)),
      stddev_read_per_min:   Math.trunc(stdev(readPerMinList)),
      p50_create_per_min:    Math.trunc(percentile(createPerMinList, 0.50)),
      p95_create_per_min:    Math.trunc(percentile(createPerMinList, 0.95)),
      avg_read_ratio:        Math.round(mean(readRatioList) * 100) / 100,
      stddev_read_ratio:     Math.round(stdev(readRatioList) * 100) / 100,
    };
  }

  const baselineData = {
    period: `${cutoff.toISOString()}:${now.toISOString()}`,
    update_timestamp: now.toISOString(),
    baselines,
  };

  mkdirSync(baselineDir, { recursive: true });
  const baselinePath = join(baselineDir, "cache_baseline.json");
  writeFileSync(baselinePath, JSON.stringify(baselineData, null, 2), "utf8");

  const historyPath = join(baselineDir, "cache_baseline_history.jsonl");
  appendFileSync(historyPath, JSON.stringify(baselineData) + "\n", "utf8");

  process.stdout.write(`Baseline updated: ${Object.keys(baselines).length} command types\n`);
  for (const [cmd, stats] of Object.entries(baselines)) {
    if (stats.sessions_count > 0) {
      process.stdout.write(`  ${cmd}: ${stats.sessions_count} sessions, avg ${stats.avg_create_per_min} CREATE/min\n`);
    }
  }
}

/**
 * Load baseline from cache_baseline.json. Returns {baselines, period, ...} or null.
 */
export function loadBaseline(baselineDir) {
  const p = join(baselineDir, "cache_baseline.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Calculate week-over-week daily average trend from baseline history.
 * Returns {current_week_avg, prior_week_avg, delta, pct_change} or null.
 */
export function buildBaselineTrend(baselineDir) {
  const historyPath = join(baselineDir, "cache_baseline_history.jsonl");
  if (!existsSync(historyPath)) return null;
  try {
    const entries = readFileSync(historyPath, "utf8")
      .split("\n")
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    if (!entries.length) return null;

    const currentEntry = entries[entries.length - 1];
    const bl = currentEntry.baselines ?? {};
    const createRates = Object.values(bl)
      .filter(b => (b.sessions_count ?? 0) > 0)
      .map(b => b.avg_create_per_min ?? 0);
    const currentAvg = createRates.length ? createRates.reduce((a, b) => a + b, 0) / createRates.length : 0;

    const now = new Date();
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    let priorEntry = null;
    for (let i = entries.length - 2; i >= 0; i--) {
      const e = entries[i];
      const periodStr = e.period ?? "";
      if (periodStr.includes(":")) {
        const startStr = periodStr.split(":")[0];
        const periodStart = new Date(startStr);
        if (!isNaN(periodStart) && periodStart < cutoff) {
          priorEntry = e;
          break;
        }
      }
    }
    if (!priorEntry) return null;

    const priorBl = priorEntry.baselines ?? {};
    const priorRates = Object.values(priorBl)
      .filter(b => (b.sessions_count ?? 0) > 0)
      .map(b => b.avg_create_per_min ?? 0);
    const priorAvg = priorRates.length ? priorRates.reduce((a, b) => a + b, 0) / priorRates.length : 0;
    if (priorAvg === 0) return null;

    const delta = currentAvg - priorAvg;
    return {
      current_week_avg: Math.trunc(currentAvg),
      prior_week_avg:   Math.trunc(priorAvg),
      delta:            Math.trunc(delta),
      pct_change:       Math.round((delta / priorAvg) * 1000) / 10,
    };
  } catch {
    return null;
  }
}
