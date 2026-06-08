// Analytics-table functions — mirrors claude_db.py callable surface for the 4
// analytics tables now folded into the single global pipeline.db.

export function appendMetricSession(db, record) {
  db.prepare(
    "INSERT OR IGNORE INTO metric_sessions " +
    "(session_id, timestamp, command_type, branch, correlation_id, " +
    "duration_seconds, files_indexed, plan_file, " +
    "cache_create_tokens, cache_read_tokens, token_source, estimation_method) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    record.session_id ?? null,
    record.timestamp ?? null,
    record.command_type ?? null,
    record.branch ?? null,
    record.correlation_id ?? null,
    record.duration_seconds ?? null,
    record.files_indexed ?? null,
    record.plan_file ?? null,
    record.cache_create_tokens ?? null,
    record.cache_read_tokens ?? null,
    record.token_source ?? null,
    record.estimation_method ?? null,
  );
}

export function loadMetricSessions(db, limit = null) {
  if (limit !== null) {
    return db.prepare(
      "SELECT * FROM metric_sessions ORDER BY timestamp DESC LIMIT ?"
    ).all(limit);
  }
  return db.prepare(
    "SELECT * FROM metric_sessions ORDER BY timestamp DESC"
  ).all();
}

export function upsertDailySpend(db, date, totalCost, cacheCreate, cacheRead, modelBreakdowns) {
  db.prepare(
    "INSERT OR REPLACE INTO daily_spend (date, total_cost, cache_create, cache_read, model_breakdowns) " +
    "VALUES (?, ?, ?, ?, ?)"
  ).run(date, totalCost, cacheCreate, cacheRead, JSON.stringify(modelBreakdowns));
}

export function loadDailySpend(db) {
  return db.prepare("SELECT * FROM daily_spend ORDER BY date").all();
}

export function appendSpawn(db, record) {
  db.prepare(
    "INSERT INTO session_spawn_map (spawn_time, corr_id, stype, cwd, project, feature, session_id) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    record.spawn_time ?? null,
    record.corr_id ?? null,
    record.stype ?? null,
    record.cwd ?? null,
    record.project ?? null,
    record.feature ?? null,
    record.session_id ?? null,
  );
}

export function updateSpawnSessionId(db, corrId, sessionId) {
  db.prepare(
    "UPDATE session_spawn_map SET session_id = ? WHERE corr_id = ? AND session_id IS NULL"
  ).run(sessionId, corrId);
}

export function loadSpawnMap(db) {
  return db.prepare("SELECT * FROM session_spawn_map ORDER BY spawn_time").all();
}

export function appendGovernorSpawn(db, record) {
  db.prepare(
    "INSERT INTO governor_spawns (slot_hour, spawn_time, corr_id, report_type) VALUES (?, ?, ?, ?)"
  ).run(
    record.slot_hour ?? null,
    record.spawn_time ?? null,
    record.corr_id ?? null,
    record.report_type ?? null,
  );
}

export function loadGovernorSpawns(db) {
  return db.prepare("SELECT * FROM governor_spawns ORDER BY spawn_time").all();
}

export function lastGovernorSpawnTime(db, slotHour) {
  const row = db.prepare(
    "SELECT spawn_time FROM governor_spawns WHERE slot_hour = ? ORDER BY spawn_time DESC LIMIT 1"
  ).get(slotHour);
  return row ? row.spawn_time : null;
}

export function getBridgeSessionChildren(db, parentSessionId) {
  return db.prepare(
    "SELECT * FROM session_spawn_map WHERE parent_session_id = ? ORDER BY spawn_time"
  ).all(parentSessionId);
}

export function appendCycleLog(db, record) {
  db.prepare(
    "INSERT INTO cycle_log " +
    "(project, feature, stage, correlation_id, start_time, end_time, duration_secs, spend_tokens, outcome) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    record.project        ?? null,
    record.feature        ?? null,
    record.stage          ?? null,
    record.correlation_id ?? null,
    record.start_time     ?? null,
    record.end_time       ?? null,
    record.duration_secs  ?? null,
    record.spend_tokens   ?? null,
    record.outcome        ?? null,
  );
}

// Load cycle_log rows, optionally filtered by project + feature.
// Returns most-recent-first up to `limit` rows (default 100).
export function loadCycleLog(db, { project = null, feature = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (project) { where.push("project = ?"); params.push(project); }
  if (feature) { where.push("feature = ?"); params.push(feature); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT * FROM cycle_log ${whereSql} ORDER BY end_time DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

export function backfillSpawnParent(db, parentSessionId, startedAt, endedAt = null) {
  let result;
  if (endedAt) {
    result = db.prepare(
      "UPDATE session_spawn_map SET parent_session_id = ? " +
      "WHERE spawn_time >= ? AND spawn_time <= ? " +
      "AND parent_session_id IS NULL AND session_id IS NOT NULL"
    ).run(parentSessionId, startedAt, endedAt);
  } else {
    result = db.prepare(
      "UPDATE session_spawn_map SET parent_session_id = ? " +
      "WHERE spawn_time >= ? " +
      "AND parent_session_id IS NULL AND session_id IS NOT NULL"
    ).run(parentSessionId, startedAt);
  }
  return result.changes;
}
