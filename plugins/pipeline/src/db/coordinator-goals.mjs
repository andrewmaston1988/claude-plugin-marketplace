// Helper functions for the coordinator_goals table in pipeline.db.
// Absorbs claude.db.coordinator_goals entries into the unified pipeline DB.
// One row per cwd; re-invoking setCoordinatorGoal refreshes set_at (TTL clock restarts).
//
// Schema mirrors claude.db.coordinator_goals (scripts/claude_db.py:312-349):
//   cwd TEXT PRIMARY KEY, set_at REAL, ttl_seconds INTEGER,
//   reason_message TEXT, set_by_session TEXT

export function setCoordinatorGoal(db, { cwd, ttlSeconds, reasonMessage = null, setBySession = null }) {
  const stmt = db.prepare(`
    INSERT INTO coordinator_goals
      (cwd, set_at, ttl_seconds, reason_message, set_by_session)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cwd) DO UPDATE SET
      set_at = excluded.set_at,
      ttl_seconds = excluded.ttl_seconds,
      reason_message = excluded.reason_message,
      set_by_session = excluded.set_by_session
  `);
  stmt.run(cwd, Date.now() / 1000, Math.max(1, Math.floor(ttlSeconds)), reasonMessage, setBySession);
}

export function getCoordinatorGoal(db, cwd) {
  const stmt = db.prepare(
    "SELECT cwd, set_at, ttl_seconds, reason_message, set_by_session " +
    "FROM coordinator_goals WHERE cwd = ? AND (set_at + ttl_seconds) > ?"
  );
  return stmt.get(cwd, Date.now() / 1000) || null;
}

export function clearCoordinatorGoal(db, cwd) {
  const stmt = db.prepare("DELETE FROM coordinator_goals WHERE cwd = ?");
  const result = stmt.run(cwd);
  return result.changes;
}

export function listCoordinatorGoals(db) {
  return db.prepare("SELECT * FROM coordinator_goals ORDER BY set_at DESC").all();
}

// Backfill: copy rows from claude.db.coordinator_goals into pipeline.db.
// Safe to re-run: uses INSERT OR REPLACE keyed on cwd.
export function backfillFromClaudeDb(db, claudeDbPath) {
  if (claudeDbPath.includes("'")) {
    throw new Error(`claudeDbPath must not contain single quotes: ${claudeDbPath}`);
  }
  db.exec(`ATTACH DATABASE '${claudeDbPath}' AS claude_attached`);
  try {
    db.exec("BEGIN");
    try {
      db.exec(`
        INSERT OR REPLACE INTO coordinator_goals
          (cwd, set_at, ttl_seconds, reason_message, set_by_session)
        SELECT
          cwd,
          CAST(set_at AS REAL) AS set_at,
          ttl_seconds,
          reason_message,
          set_by_session
        FROM claude_attached.coordinator_goals
      `);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.exec("DETACH DATABASE claude_attached");
  }
}
