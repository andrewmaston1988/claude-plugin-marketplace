// Report generation: generate-report, generate-status-report.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadMetricSessions, loadSpawnMap } from "../db/index.mjs";
import {
  getCcusageRangeData, getCcusageSessionData,
} from "./ccusage.mjs";
import {
  calcBurnRate, calcCircuitStatus, dominantModelStr, modelShortName,
  buildSpendByType, buildSpendByProject, buildModelCompliance, getDailyAvgSpend,
} from "./spend.mjs";
import { loadBaseline, buildBaselineTrend } from "./baselines.mjs";
import { detectSessionAnomalies } from "./anomaly.mjs";
import { parseTimestamp, countProjectConversations, getAllCommandTypes } from "./sessions.mjs";

const DEFAULT_BRANCH = "master";

const ORDER = getAllCommandTypes();

/**
 * generate-report: deterministic raw-numbers report for a given date.
 * Writes metrics-raw-<dateStr>.md to reportsDir. Returns true on success.
 */
export async function generateReport(db, dateStr, { reportsDir, baselineDir, rolling = false }) {
  let reportDate;
  try {
    if (!/^\d{8}$/.test(dateStr)) throw new Error();
    reportDate = new Date(Date.UTC(
      parseInt(dateStr.slice(0, 4), 10),
      parseInt(dateStr.slice(4, 6), 10) - 1,
      parseInt(dateStr.slice(6, 8), 10),
    ));
  } catch {
    process.stdout.write(`Invalid date format: ${dateStr}. Use YYYYMMDD.\n`);
    return false;
  }

  const baselineData = loadBaseline(baselineDir);
  if (!baselineData) {
    process.stdout.write("Baseline file not found. Run update-sessions and update-baselines first.\n");
    return false;
  }
  const baselines = baselineData.baselines ?? {};

  const nowUtc = new Date();
  const todayStr = nowUtc.toISOString().slice(0, 10).replace(/-/g, "");
  const isToday = dateStr === todayStr;

  let windowStart, windowEnd, windowLabel;
  if (rolling) {
    windowEnd   = nowUtc;
    windowStart = new Date(nowUtc.getTime() - 24 * 60 * 60 * 1000);
    windowLabel = `rolling 24h (ending ${nowUtc.toISOString().slice(0, 16).replace("T", " ")} UTC)`;
  } else {
    windowStart = new Date(Date.UTC(reportDate.getUTCFullYear(), reportDate.getUTCMonth(), reportDate.getUTCDate()));
    windowEnd   = new Date(windowStart.getTime() + 24 * 60 * 60 * 1000);
    windowLabel = `UTC calendar day ${dateStr}`;
  }

  const realSessionCount = countProjectConversations(windowStart, windowEnd);

  const allSessions = loadMetricSessions(db);
  const sessionsInWindow = allSessions.filter(s => {
    const ts = parseTimestamp(s.timestamp);
    return ts && ts >= windowStart && ts < windowEnd;
  });

  const byCommand = {};
  for (const s of sessionsInWindow) {
    const cmd = s.command_type ?? "unknown";
    (byCommand[cmd] = byCommand[cmd] ?? []).push(s);
  }

  const totalTracked = sessionsInWindow.length;
  const totalDuration = sessionsInWindow.reduce((sum, s) => sum + (s.duration_seconds ?? 0), 0);
  const metricSessionsDict = {};
  for (const s of sessionsInWindow) metricSessionsDict[s.session_id] = s;

  const dailyRows = await getCcusageRangeData(dateStr, dateStr);
  const ccusageSessions = (await getCcusageSessionData(dateStr)) ?? [];

  let totalCreate = 0, totalRead = 0, spendEstimate = 0, modelBreakdowns = [], dataSource;
  if (dailyRows && dailyRows.length) {
    const row = dailyRows[0];
    totalCreate     = row.cacheCreationTokens ?? 0;
    totalRead       = row.cacheReadTokens ?? 0;
    spendEstimate   = row.totalCost ?? 0;
    modelBreakdowns = row.modelBreakdowns ?? [];
    dataSource      = "ccusage (real)";
  } else {
    const suffix = rolling ? "-rolling" : "";
    let report = `# Cache Health Report — ${dateStr}\n\n\`Data Source Unavailable (ccusage failed)\`\n`;
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(join(reportsDir, `metrics-raw-${dateStr}${suffix}.md`), report, "utf8");
    process.stdout.write(`Report generated: ${join(reportsDir, `metrics-raw-${dateStr}${suffix}.md`)}\n`);
    return true;
  }

  const dailyAvgSpend = await getDailyAvgSpend(todayStr);
  const hoursElapsed = (isToday && !rolling)
    ? (nowUtc.getTime() - windowStart.getTime()) / 3_600_000
    : 0;
  const projectedSpend = hoursElapsed > 0.5 ? spendEstimate / hoursElapsed * 24 : 0;

  const rcRatio = totalCreate > 0 ? totalRead / totalCreate : Infinity;
  let cacheStatus, cacheNote;
  if (rcRatio > 10)      { cacheStatus = "✅ Green";    cacheNote = "Cache stable, sessions reusing context efficiently"; }
  else if (rcRatio >= 5) { cacheStatus = "⚠️ Yellow";  cacheNote = "Cache partially degraded — investigate prompt prefix drift"; }
  else if (rcRatio >= 2) { cacheStatus = "🔴 Red";     cacheNote = "Cache mostly busted — agents paying near-full price per session"; }
  else                   { cacheStatus = "🚨 Critical"; cacheNote = "Caching adding overhead with no benefit"; }

  const anomalies = detectSessionAnomalies(sessionsInWindow, baselines);
  const overallEfficiency = totalDuration > 0 ? totalCreate / (totalDuration / 60) : 0;
  const baselineVals = Object.values(baselines).filter(Boolean);
  const baselineEfficiency = baselineVals.length
    ? baselineVals.reduce((s, b) => s + (b.avg_create_per_min ?? 0), 0) / baselineVals.length
    : 0;
  const efficiencyChange = baselineEfficiency > 0
    ? (overallEfficiency - baselineEfficiency) / baselineEfficiency * 100
    : 0;

  const partialNote = (isToday && !rolling && hoursElapsed > 0)
    ? ` _(partial — ${hoursElapsed.toFixed(1)}h elapsed of 24h)_`
    : "";

  let report = `# Cache Health Report — ${dateStr}${partialNote}\n\n`;
  report += `_Window: ${windowLabel}_\n\n`;

  report += "## Activity Summary\n";
  report += `- **Sessions (real):** ${realSessionCount}`;
  if (totalTracked !== realSessionCount) report += `  _(metric-tracked: ${totalTracked})_`;
  report += "\n";
  report += `- **Total duration (tracked):** ${Math.trunc(totalDuration / 60)} min\n`;
  report += `- **Spend:** $${spendEstimate.toFixed(2)}`;
  if (projectedSpend > 0) report += `  _(projected: $${projectedSpend.toFixed(0)})_`;
  if (dailyAvgSpend > 0) {
    const pct = spendEstimate / dailyAvgSpend * 100;
    report += `  _(7-day avg: $${dailyAvgSpend.toFixed(0)}/day, ${pct.toFixed(0)}% of avg)_`;
  }
  report += "\n";
  const burnRate = calcBurnRate(spendEstimate, (isToday && !rolling) ? hoursElapsed : 24);
  report += `- **🔥 Burn rate:** $${burnRate.toFixed(2)}/hr\n`;
  if (dataSource?.includes("unavailable")) {
    report += `- **Data source:** \`${dataSource}\`\n`;
  } else {
    report += `- **Data source:** ${dataSource}\n`;
  }
  report += `- **Avg CREATE/min:** ${Math.trunc(overallEfficiency).toLocaleString()}\n\n`;

  report += "## Cache Efficiency\n";
  report += `**R/C Ratio:** ${rcRatio === Infinity ? "∞" : rcRatio.toFixed(1)}:1 ${cacheStatus}\n`;
  report += `- ${cacheNote}\n`;
  report += `- **Cache Create:** ${totalCreate.toLocaleString()} tokens\n`;
  report += `- **Cache Read:** ${totalRead.toLocaleString()} tokens\n\n`;

  if (modelBreakdowns.length) {
    const dom = dominantModelStr(modelBreakdowns, spendEstimate);
    report += `## By Model${dom ? `  _(dominant: ${dom})_` : ""}\n\n`;
    const sorted = [...modelBreakdowns].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
    for (const mb of sorted) {
      const name   = modelShortName(mb.modelName ?? "unknown");
      const cost   = mb.cost ?? 0;
      const create = mb.cacheCreationTokens ?? 0;
      const read   = mb.cacheReadTokens ?? 0;
      const rc     = create > 0 ? read / create : 0;
      report += `- **${name}**: $${cost.toFixed(2)}  R/C ${rc.toFixed(0)}x  (${create.toLocaleString()} write / ${read.toLocaleString()} read)\n`;
    }
    report += "\n";
  }

  report += "## Per-Command Breakdown\n\n";
  let hasAny = false;
  for (const cmdType of ORDER) {
    const sessionsForType = byCommand[cmdType] ?? [];
    if (!sessionsForType.length) continue;
    hasAny = true;
    const totalDur = sessionsForType.reduce((s, x) => s + (x.duration_seconds ?? 0), 0);
    const avgCpm   = Math.trunc(sessionsForType.reduce((s, x) => s + (x.cache_create_tokens ?? 0), 0) / (totalDur / 60 + 0.1));
    const avgTurns = Math.trunc(sessionsForType.reduce((s, x) => s + (x.turn_count ?? 0), 0) / sessionsForType.length);
    const blCreate = baselines[cmdType]?.avg_create_per_min ?? 0;
    const status   = blCreate > 0
      ? (Math.abs(avgCpm - blCreate) / blCreate < 0.2 ? "✓ normal" : "⚠️ below baseline")
      : "(no baseline)";
    const turnsNote = avgTurns > 0 ? `  avg ${avgTurns} turns` : "";
    report += `- **${cmdType}** (${sessionsForType.length} sessions): ${avgCpm.toLocaleString()} CREATE/min ${status}${turnsNote}\n`;
  }
  if (!hasAny) report += "_No sessions in metric window._\n";

  // Spend attribution sections
  const spawnMap = loadSpawnMap(db);
  const spawnLookup = {};
  for (const e of spawnMap) { if (e.session_id) spawnLookup[e.session_id] = e; }

  const spendByType = buildSpendByType(ccusageSessions, metricSessionsDict);
  if (Object.keys(spendByType).length) {
    report += "\n## Spend by Type\n";
    for (const cmdType of ORDER) {
      const data = spendByType[cmdType];
      if (data) report += `- **${cmdType}** (${data.count} sessions): $${data.cost.toFixed(2)}\n`;
    }
    report += "\n";
  }

  const spendByProject = buildSpendByProject(ccusageSessions, spawnLookup);
  if (Object.keys(spendByProject).length) {
    report += "## Spend by Project\n";
    const sortedProjects = Object.entries(spendByProject).sort((a, b) => b[1].cost - a[1].cost);
    for (const [project, data] of sortedProjects) {
      report += `- **${project}**: $${data.cost.toFixed(2)} (${data.count} sessions)\n`;
    }
    report += "\n";
  }

  const modelCompliance = buildModelCompliance(ccusageSessions, metricSessionsDict);
  if (Object.keys(modelCompliance).length) {
    report += "## Model Compliance\n";
    for (const cmdType of ORDER) {
      const data = modelCompliance[cmdType];
      if (data && (data.haiku + data.sonnet + data.opus) > 0) {
        const parts = [];
        if (data.haiku  > 0) parts.push(`${data.haiku} Haiku ✅`);
        if (data.sonnet > 0) parts.push(`${data.sonnet} Sonnet ⚠️`);
        if (data.opus   > 0) parts.push(`${data.opus} Opus 🔴`);
        report += `- **${cmdType}**: ${parts.join(", ")}\n`;
      }
    }
    report += "\n";
  }

  // Baseline Trend
  const trend = buildBaselineTrend(baselineDir);
  if (trend) {
    report += "## Baseline Trend\n";
    const deltaStr = trend.delta >= 0 ? `+$${trend.delta}/day` : `$${trend.delta}/day`;
    const pctStr   = trend.pct_change >= 0 ? `+${trend.pct_change}%` : `${trend.pct_change}%`;
    const trendStatus = trend.pct_change > 20 ? "⬆️ increasing" : (trend.pct_change > -10 ? "stable" : "⬇️ decreasing");
    report += `- **7-day daily avg:** $${trend.current_week_avg}/day (${deltaStr}, ${pctStr} ${trendStatus})\n\n`;
  }

  report += "## Anomalies Detected\n";
  if (anomalies.length) {
    anomalies.forEach((anom, i) => {
      report += `${i + 1}. **${anom.command_type} anomaly** (z=${anom.z_score.toFixed(2)})\n`;
      report += `   - Actual: ${Math.trunc(anom.actual_per_min).toLocaleString()} CREATE/min (baseline: ${Math.trunc(anom.baseline_per_min).toLocaleString()})\n`;
      report += `   - Duration: ${anom.duration_sec}s\n\n`;
    });
  } else {
    report += "None detected.\n";
  }

  // Cold-cache sessions
  const coldCache = sessionsInWindow
    .filter(s => {
      const r = s.cache_read_ratio ?? Infinity;
      return r > 0 && r < 5 && (s.turn_count ?? 0) >= 3;
    })
    .sort((a, b) => (a.cache_read_ratio ?? 99) - (b.cache_read_ratio ?? 99))
    .slice(0, 10);
  if (coldCache.length) {
    report += "\n### Cold-Cache Sessions (R/C < 5x, ≥3 turns)\n";
    for (const s of coldCache) {
      const cmd = s.command_type !== "unknown" ? s.command_type : "unclassified";
      const branch = s.branch ?? "";
      const branchNote = (branch && branch !== DEFAULT_BRANCH) ? ` [${branch}]` : "";
      const ts = parseTimestamp(s.timestamp);
      const timeNote = ts ? ` ${ts.toISOString().slice(11, 16)} UTC` : "";
      report += `- \`${(s.session_id ?? "").slice(0, 8)}\` (${cmd}${branchNote}${timeNote}) R/C ${(s.cache_read_ratio ?? 0).toFixed(1)}x — ${s.duration_seconds}s, ${s.turn_count ?? "?"} turns\n`;
    }
  }

  report += `\n## Trends\n`;
  report += `- **Cache efficiency:** ${Math.trunc(overallEfficiency).toLocaleString()} tokens/min (was ${Math.trunc(baselineEfficiency).toLocaleString()}, ${efficiencyChange >= 0 ? "+" : ""}${efficiencyChange.toFixed(1)}%)\n`;
  report += `- **Recommendation:** ${efficiencyChange < -10 ? "Monitor efficiency trend" : "Efficiency stable"}\n`;

  report += "\n## Circuit Status\n";
  const spendForThreshold = (isToday && !rolling && projectedSpend > 0) ? projectedSpend : spendEstimate;
  const circuitStatus = calcCircuitStatus(spendForThreshold, dailyAvgSpend);
  if (dailyAvgSpend > 0) {
    const actualPct = spendEstimate / dailyAvgSpend * 100;
    let circuitLine = `${circuitStatus} — $${spendEstimate.toFixed(2)} spend  (${actualPct.toFixed(0)}% of ${dailyAvgSpend.toFixed(0)} avg)`;
    if (isToday && !rolling && projectedSpend > 0 && projectedSpend !== spendEstimate) {
      const pctOfAvg = spendForThreshold / dailyAvgSpend * 100;
      circuitLine += `  (projected $${projectedSpend.toFixed(0)}, ${pctOfAvg.toFixed(0)}%)`;
    }
    report += circuitLine + "\n";
  } else {
    report += `${circuitStatus} — $${spendEstimate.toFixed(2)} spend\n`;
  }

  mkdirSync(reportsDir, { recursive: true });
  const suffix = rolling ? "-rolling" : "";
  const reportPath = join(reportsDir, `metrics-raw-${dateStr}${suffix}.md`);
  writeFileSync(reportPath, report, "utf8");
  process.stdout.write(`Report generated: ${reportPath}\n`);
  return true;
}

/**
 * generate-status-report: lightweight intraday status.
 */
export async function generateStatusReport(db, dateStr, { reportsDir }) {
  const nowUtc = new Date();
  const reportDate = new Date(Date.UTC(
    parseInt(dateStr.slice(0, 4), 10),
    parseInt(dateStr.slice(4, 6), 10) - 1,
    parseInt(dateStr.slice(6, 8), 10),
  ));
  const hoursElapsed = Math.min((nowUtc.getTime() - reportDate.getTime()) / 3_600_000, 24);

  const dailyRows = await getCcusageRangeData(dateStr, dateStr);
  mkdirSync(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `status-${dateStr}.md`);

  if (!dailyRows || !dailyRows.length) {
    writeFileSync(reportPath, `# Status — ${dateStr}\n\n\`ccusage unavailable\`\n`, "utf8");
    process.stdout.write(`Status report: ${reportPath}\n`);
    return;
  }

  const row = dailyRows[0];
  const cost = row.totalCost ?? 0;
  const burnRate = calcBurnRate(cost, hoursElapsed);
  const yesterdayStr = new Date(nowUtc.getTime() - 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
  const dailyAvg = await getDailyAvgSpend(yesterdayStr);
  const circuit = calcCircuitStatus(cost, dailyAvg);
  const dom = dominantModelStr(row.modelBreakdowns ?? [], cost);

  let report = `# Status — ${dateStr}\n\n`;
  report += `- **Spend:** $${cost.toFixed(2)}`;
  if (dailyAvg > 0) report += `  _(7-day avg: $${dailyAvg.toFixed(0)}/day, ${(cost / dailyAvg * 100).toFixed(0)}% of avg)_`;
  report += "\n";
  report += `- **🔥 Burn rate:** $${burnRate.toFixed(2)}/hr\n`;
  if (dom) report += `- **Dominant model:** ${dom}\n`;
  report += "\n";
  if (dailyAvg > 0) {
    report += `${circuit} — $${cost.toFixed(2)} spend  (${(cost / dailyAvg * 100).toFixed(0)}% of ${dailyAvg.toFixed(0)} avg)\n`;
  } else {
    report += `${circuit} — $${cost.toFixed(2)} spend\n`;
  }

  writeFileSync(reportPath, report, "utf8");
  process.stdout.write(`Status report: ${reportPath}\n`);
}
