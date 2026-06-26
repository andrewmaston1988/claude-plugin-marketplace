// Spend archival: update-spend, monthly-metrics, daily avg.
import { loadDailySpend, loadMetricSessions, upsertDailySpend } from "../db/index.mjs";
import { getCcusageRangeData } from "./ccusage.mjs";
import { parseTimestamp } from "./sessions.mjs";

/**
 * update-spend: archive ccusage daily totals for dateStr to pipeline.db.
 * Past days: skip if already present. Today: always overwrite.
 */
export async function updateSpend(db, dateStr, dryRun = false) {
  const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const isToday = dateStr === todayStr;

  if (!isToday) {
    const existing = loadDailySpend(db).find(r => r.date === dateStr);
    if (existing) {
      process.stdout.write(`Spend data for ${dateStr} already present — skipping\n`);
      return;
    }
  }

  const rows = await getCcusageRangeData(dateStr, dateStr);
  if (!rows || !rows.length) {
    process.stdout.write(`No ccusage data for ${dateStr} — not persisting\n`);
    return;
  }

  const row = rows[0];
  if (!dryRun) {
    upsertDailySpend(
      db,
      dateStr,
      row.totalCost ?? 0,
      row.cacheCreationTokens ?? 0,
      row.cacheReadTokens ?? 0,
      row.modelBreakdowns ?? [],
    );
  }
  const action = dryRun ? "[dry-run] Would persist" : (isToday ? "Updated" : "Persisted");
  process.stdout.write(`${action} spend data for ${dateStr}: $${(row.totalCost ?? 0).toFixed(2)}\n`);
}

/**
 * Return 7-day average daily spend (days with >$1 spend only) ending at untilDateStr.
 */
export async function getDailyAvgSpend(untilDateStr) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekAgoStr = weekAgo.toISOString().slice(0, 10).replace(/-/g, "");
  const rows = await getCcusageRangeData(weekAgoStr, untilDateStr) ?? [];
  const active = rows.filter(r => (r.totalCost ?? 0) > 1.0);
  return active.length ? active.reduce((s, r) => s + (r.totalCost ?? 0), 0) / active.length : 0;
}

export function calcBurnRate(cost, hoursElapsed) {
  return hoursElapsed > 0.1 ? cost / hoursElapsed : 0;
}

export function calcCircuitStatus(cost, baseline = 0) {
  if (baseline > 0) {
    const pct = cost / baseline;
    if (pct < 1.5)  return "🟢 Green";
    if (pct < 2.5)  return "🟡 Yellow";
    if (pct < 4.0)  return "🔴 Red";
    return "🚨 Critical";
  }
  if (cost < 30)   return "🟢 Green";
  if (cost < 100)  return "🟡 Yellow";
  if (cost < 200)  return "🔴 Red";
  return "🚨 Critical";
}

export function modelShortName(modelId) {
  const m = (modelId ?? "").toLowerCase();
  if (m.includes("opus"))   return "Opus";
  if (m.includes("sonnet")) return "Sonnet";
  if (m.includes("haiku"))  return "Haiku";
  return modelId;
}

export function dominantModelStr(modelBreakdowns, totalCost) {
  if (!modelBreakdowns?.length || totalCost <= 0) return "";
  const top = modelBreakdowns.reduce((a, b) => (a.cost ?? 0) > (b.cost ?? 0) ? a : b);
  const pct = (top.cost ?? 0) / totalCost * 100;
  return `${modelShortName(top.modelName ?? "?")} (${Math.round(pct)}% of spend)`;
}

/** Aggregate spend by session type from ccusage session rows + metric sessions dict. */
export function buildSpendByType(ccusageSessions, metricSessionsMap) {
  const out = {};
  for (const s of ccusageSessions) {
    const sid = s.sessionId ?? "";
    const cost = s.totalCost ?? 0;
    const metric = metricSessionsMap[sid];
    const cmdType = metric?.command_type ?? "unknown";
    (out[cmdType] = out[cmdType] ?? { count: 0, cost: 0 }).count++;
    out[cmdType].cost += cost;
  }
  return out;
}

/** Aggregate spend by project from ccusage sessions + spawn lookup dict. */
export function buildSpendByProject(ccusageSessions, spawnLookup) {
  const out = {};
  for (const s of ccusageSessions) {
    const sid = s.sessionId ?? "";
    const cost = s.totalCost ?? 0;
    const project = spawnLookup[sid]?.project ?? "unknown";
    (out[project] = out[project] ?? { count: 0, cost: 0 }).count++;
    out[project].cost += cost;
  }
  return out;
}

/** Flag model compliance violations per session type. */
export function buildModelCompliance(ccusageSessions, metricSessionsMap) {
  const out = {};
  for (const s of ccusageSessions) {
    const sid = s.sessionId ?? "";
    const cmdType = metricSessionsMap[sid]?.command_type ?? "unknown";
    (out[cmdType] = out[cmdType] ?? { haiku: 0, sonnet: 0, opus: 0 });
    for (const model of (s.modelsUsed ?? [])) {
      const ml = model.toLowerCase();
      if (ml.includes("opus"))        out[cmdType].opus++;
      else if (ml.includes("sonnet")) out[cmdType].sonnet++;
      else                            out[cmdType].haiku++;
    }
  }
  return out;
}

/**
 * compute monthly metrics for month_str (YYYYMM).
 * Returns structured dict or null on invalid input.
 */
export function computeMonthlyMetrics(db, monthStr) {
  if (!/^\d{6}$/.test(monthStr)) {
    process.stderr.write(`Invalid month format: ${monthStr}. Use YYYYMM.\n`);
    return null;
  }
  const year  = parseInt(monthStr.slice(0, 4), 10);
  const month = parseInt(monthStr.slice(4, 6), 10);

  // Calendar month bounds (UTC)
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd   = new Date(Date.UTC(year, month - 1, lastDay, 23, 59, 59));

  const monthLabel = monthStart.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const nextMonthDt = new Date(Date.UTC(year, month, 1));
  const nextMonthLabel = nextMonthDt.toLocaleString("en-US", { month: "long", timeZone: "UTC" });

  const allDaily = loadDailySpend(db);
  const allSessions = loadMetricSessions(db);

  const dayRows = {};
  for (const row of allDaily) {
    const ds = String(row.date ?? "");
    if (ds.length === 8 && ds.slice(0, 6) === monthStr) dayRows[ds] = row;
  }

  const sessionsInMonth = allSessions.filter(s => {
    const ts = parseTimestamp(s.timestamp);
    return ts && ts >= monthStart && ts <= monthEnd;
  });

  const weekOf = day => Math.min(Math.floor((day - 1) / 7) + 1, 5);

  const weekLabels = {};
  const mo = monthStart.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  weekLabels[1] = `W1 (${mo} 1-7)`;
  weekLabels[2] = `W2 (${mo} 8-14)`;
  weekLabels[3] = `W3 (${mo} 15-21)`;
  weekLabels[4] = `W4 (${mo} 22-28)`;
  if (lastDay > 28) weekLabels[5] = `W5 (${mo} 29-${lastDay})`;

  const weekSpend      = Object.fromEntries(Object.keys(weekLabels).map(w => [w, 0]));
  const weekCacheCreate = Object.fromEntries(Object.keys(weekLabels).map(w => [w, 0]));
  const weekCacheRead   = Object.fromEntries(Object.keys(weekLabels).map(w => [w, 0]));
  const weekModelSpend  = Object.fromEntries(Object.keys(weekLabels).map(w => [w, {}]));
  const weekSessions    = Object.fromEntries(Object.keys(weekLabels).map(w => [w, []]));

  let totalSpend = 0, totalCreate = 0, totalRead = 0, daysWithData = 0;

  for (let dayNum = 1; dayNum <= lastDay; dayNum++) {
    const dateKey = `${year}${String(month).padStart(2, "0")}${String(dayNum).padStart(2, "0")}`;
    const w = weekOf(dayNum);
    if (dayRows[dateKey]) {
      const row = dayRows[dateKey];
      const cost = row.total_cost ?? 0;
      const cc   = row.cache_create ?? 0;
      const cr   = row.cache_read ?? 0;
      weekSpend[w]      = (weekSpend[w] ?? 0) + cost;
      weekCacheCreate[w] = (weekCacheCreate[w] ?? 0) + cc;
      weekCacheRead[w]   = (weekCacheRead[w] ?? 0) + cr;
      totalSpend  += cost;
      totalCreate += cc;
      totalRead   += cr;
      daysWithData++;
      let mb = [];
      try { mb = typeof row.model_breakdowns === "string" ? JSON.parse(row.model_breakdowns) : (row.model_breakdowns ?? []); }
      catch {}
      for (const entry of (mb ?? [])) {
        const model = entry.model ?? "unknown";
        weekModelSpend[w][model] = (weekModelSpend[w][model] ?? 0) + (entry.cost ?? 0);
      }
    }
  }

  for (const s of sessionsInMonth) {
    const ts = parseTimestamp(s.timestamp);
    if (ts) {
      const w = weekOf(ts.getUTCDate());
      if (weekSessions[w]) weekSessions[w].push(s);
    }
  }

  const rcRatioStr = (cc, cr) => cc === 0 ? "N/A" : `${Math.round(cr / cc)}:1`;

  const sessionsByType = {};
  for (const s of sessionsInMonth) {
    const cmd = s.command_type ?? "unknown";
    (sessionsByType[cmd] = sessionsByType[cmd] ?? []).push(s);
  }

  const typeStats = {};
  for (const [cmd, slist] of Object.entries(sessionsByType)) {
    const cc = slist.reduce((sum, s) => sum + (s.cache_create_tokens ?? 0), 0);
    const cr = slist.reduce((sum, s) => sum + (s.cache_read_tokens ?? 0), 0);
    typeStats[cmd] = {
      count: slist.length,
      cache_create: cc,
      cache_read: cr,
      rc: rcRatioStr(cc, cr),
      avg_tokens_created: slist.length ? cc / slist.length : 0,
    };
  }

  const overallRcStr = rcRatioStr(totalCreate, totalRead);
  const overallRcVal = totalCreate > 0 ? totalRead / totalCreate : 0;
  const structuralCold = new Set(["slack_verb", "annotate", "merge"]);
  const substantive = sessionsInMonth.filter(s => !structuralCold.has(s.command_type));
  const spendPerSession = substantive.length ? totalSpend / substantive.length : 0;

  // Prior month
  const priorMonthDt = new Date(Date.UTC(year, month - 2, 1));
  const priorYear  = priorMonthDt.getUTCFullYear();
  const priorMonth = priorMonthDt.getUTCMonth() + 1;
  const priorMonthStr = `${priorYear}${String(priorMonth).padStart(2, "0")}`;

  let priorSpend = 0, priorCreate = 0, priorRead = 0;
  for (const row of allDaily) {
    const ds = String(row.date ?? "");
    if (ds.length === 8 && ds.slice(0, 6) === priorMonthStr) {
      priorSpend  += row.total_cost ?? 0;
      priorCreate += row.cache_create ?? 0;
      priorRead   += row.cache_read ?? 0;
    }
  }
  const priorLastDay = new Date(Date.UTC(priorYear, priorMonth, 0)).getUTCDate();
  const priorDailyAvg    = priorLastDay > 0 ? priorSpend / priorLastDay : 0;
  const monthlyDailyAvg  = lastDay > 0 ? totalSpend / lastDay : 0;
  const priorRcVal = priorCreate > 0 ? priorRead / priorCreate : 0;

  const circuitStatus = (() => {
    if (priorDailyAvg > 0) {
      const pct = monthlyDailyAvg / priorDailyAvg;
      if (pct < 1.5)  return "🟢 Green";
      if (pct < 2.5)  return "🟡 Yellow";
      if (pct < 4.0)  return "🔴 Red";
      return "🚨 Critical";
    }
    if (monthlyDailyAvg < 30)  return "🟢 Green";
    if (monthlyDailyAvg < 100) return "🟡 Yellow";
    if (monthlyDailyAvg < 200) return "🔴 Red";
    return "🚨 Critical";
  })();

  const spendChangePct = priorDailyAvg > 0
    ? (monthlyDailyAvg - priorDailyAvg) / priorDailyAvg * 100
    : 0;

  const weeksOut = Object.keys(weekLabels).map(wk => {
    const w = parseInt(wk, 10);
    const ccW = weekCacheCreate[w] ?? 0;
    const crW = weekCacheRead[w] ?? 0;
    const rcValW = ccW > 0 ? crW / ccW : 0;
    const wSess = weekSessions[w] ?? [];
    const wSubst = wSess.filter(s => !structuralCold.has(s.command_type));
    const spsW = wSubst.length ? (weekSpend[w] ?? 0) / wSubst.length : 0;
    const modelsW = Object.entries(weekModelSpend[w] ?? {}).sort((a, b) => b[1] - a[1]);
    const modelsTot = modelsW.reduce((s, [, c]) => s + c, 0);
    return {
      label:    weekLabels[w],
      spend:    weekSpend[w] ?? 0,
      cache_create: ccW,
      cache_read:   crW,
      rc_str:   rcRatioStr(ccW, crW),
      rc_val:   rcValW,
      session_count: wSess.length,
      substantive_count: wSubst.length,
      spend_per_substantive_session: spsW,
      models: modelsW.map(([model, cost]) => ({
        model,
        spend: cost,
        pct:   modelsTot > 0 ? cost / modelsTot * 100 : 0,
      })),
    };
  });

  const allModelSpend = {};
  for (const w of Object.keys(weekLabels)) {
    for (const [model, cost] of Object.entries(weekModelSpend[w] ?? {})) {
      allModelSpend[model] = (allModelSpend[model] ?? 0) + cost;
    }
  }
  const totalModelSpend = Object.values(allModelSpend).reduce((a, b) => a + b, 0);
  const monthModelsOut = Object.entries(allModelSpend)
    .sort((a, b) => b[1] - a[1])
    .map(([model, cost]) => ({ model, spend: cost, pct: totalModelSpend > 0 ? cost / totalModelSpend * 100 : 0 }));

  const sortedTypes = Object.entries(typeStats).sort((a, b) => b[1].count - a[1].count);
  const typesOut = sortedTypes.map(([cmd, stats]) => ({
    name:               cmd,
    count:              stats.count,
    cache_create:       stats.cache_create,
    cache_read:         stats.cache_read,
    rc_str:             stats.rc,
    avg_tokens_created: stats.avg_tokens_created,
    structural_cold:    structuralCold.has(cmd),
  }));

  const rcTrend = overallRcVal > priorRcVal ? "improved" : (overallRcVal < priorRcVal ? "degraded" : "held steady");
  const spendTrend = totalSpend > priorSpend ? "higher" : (totalSpend < priorSpend ? "lower" : "flat");

  return {
    month_str:       monthStr,
    month_label:     monthLabel,
    next_month_label: nextMonthLabel,
    prior_month_label: priorMonthDt.toLocaleString("en-US", { month: "long", timeZone: "UTC" }),
    last_day:        lastDay,
    days_with_data:  daysWithData,
    missing_days:    lastDay - daysWithData,
    totals: {
      spend:                         totalSpend,
      sessions:                      sessionsInMonth.length,
      substantive_sessions:          substantive.length,
      cache_create:                  totalCreate,
      cache_read:                    totalRead,
      rc_str:                        overallRcStr,
      rc_val:                        overallRcVal,
      monthly_daily_avg:             monthlyDailyAvg,
      spend_per_substantive_session: spendPerSession,
    },
    weeks:           weeksOut,
    month_model_mix: monthModelsOut,
    session_types:   typesOut,
    sessions_by_project: {},  // populated by caller if spawn map available
    total_spend:     totalSpend,
    anomalies:       [],      // populated by caller
    prior_month: {
      spend:       priorSpend,
      cache_create: priorCreate,
      cache_read:  priorRead,
      rc_str:      rcRatioStr(priorCreate, priorRead),
      rc_val:      priorRcVal,
      daily_avg:   priorDailyAvg,
    },
    comparison: {
      rc_trend:   rcTrend,
      spend_trend: spendTrend,
      spend_change_pct_vs_prior_daily_avg: spendChangePct,
    },
    circuit_status: circuitStatus,
  };
}
