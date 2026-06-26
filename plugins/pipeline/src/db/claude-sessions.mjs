// Helper functions for claude_sessions table in pipeline.db
// Absorbs claude.db.claude_sessions entries into the unified pipeline DB

export function upsertClaudeSession(db, { sessionId, cwd, startedAt, userTs, summary }) {
  // When userTs is null (keepalive tick), fetch the existing value to preserve it on INSERT.
  // If there's no existing row, use startedAt as fallback. This ensures we never violate
  // the user_ts NOT NULL constraint while still preserving the value on keepalive.
  let finalUserTs = userTs;
  if (finalUserTs === null) {
    const existing = db.prepare("SELECT user_ts FROM claude_sessions WHERE session_id = ?").get(sessionId);
    finalUserTs = existing ? existing.user_ts : startedAt;
  }

  const stmt = db.prepare(`
    INSERT INTO claude_sessions (session_id, cwd, started_at, user_ts, summary)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      cwd = excluded.cwd,
      user_ts = COALESCE(excluded.user_ts, claude_sessions.user_ts),
      summary = excluded.summary
  `);
  stmt.run(sessionId, cwd, startedAt, finalUserTs, summary);
}

export function getClaudeSession(db, sessionId) {
  const stmt = db.prepare("SELECT * FROM claude_sessions WHERE session_id = ?");
  return stmt.get(sessionId) || null;
}

export function listActiveClaudeSessionsByCwd(db, cwd) {
  const stmt = db.prepare("SELECT * FROM claude_sessions WHERE cwd = ?");
  return stmt.all(cwd);
}

export function getLastCheckpointSize(db, sessionId) {
  const stmt = db.prepare("SELECT last_checkpoint_size FROM claude_sessions WHERE session_id = ?");
  const result = stmt.get(sessionId);
  return result ? result.last_checkpoint_size : null;
}

export function setLastCheckpointSize(db, sessionId, bytes) {
  const stmt = db.prepare("UPDATE claude_sessions SET last_checkpoint_size = ? WHERE session_id = ?");
  stmt.run(bytes, sessionId);
}

export function listAllClaudeSessionIds(db) {
  return db.prepare("SELECT session_id FROM claude_sessions").all().map(r => r.session_id);
}

// Backfill: copy rows from claude.db into pipeline.db.claude_sessions
// Safe to re-run: uses INSERT OR REPLACE, maps ts column to started_at
export function backfillFromClaudeDb(db, claudeDbPath) {
  if (claudeDbPath.includes("'")) {
    throw new Error(`claudeDbPath must not contain single quotes: ${claudeDbPath}`);
  }
  db.exec(`ATTACH DATABASE '${claudeDbPath}' AS claude_attached`);
  try {
    db.exec("BEGIN");
    try {
      db.exec(`
        INSERT OR REPLACE INTO claude_sessions
          (session_id, cwd, started_at, user_ts, summary, last_checkpoint_size)
        SELECT
          session_id,
          cwd,
          CAST(ts AS REAL) AS started_at,
          CAST(user_ts AS REAL) AS user_ts,
          NULL AS summary,
          last_checkpoint_size
        FROM claude_attached.claude_sessions
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
