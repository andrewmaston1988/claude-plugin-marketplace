// Helper functions for claude_sessions table in pipeline.db
// Absorbs claude.db.claude_sessions entries into the unified pipeline DB

export function upsertClaudeSession(db, { sessionId, cwd, startedAt, userTs, summary }) {
  const stmt = db.prepare(`
    INSERT INTO claude_sessions (session_id, cwd, started_at, user_ts, summary)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      cwd = excluded.cwd,
      user_ts = excluded.user_ts,
      summary = excluded.summary
  `);
  stmt.run(sessionId, cwd, startedAt, userTs, summary);
}

export function getClaudeSession(db, sessionId) {
  const stmt = db.prepare("SELECT * FROM claude_sessions WHERE session_id = ?");
  return stmt.get(sessionId) || null;
}

export function listActiveClaudeSessionsByCwd(db, cwd) {
  const stmt = db.prepare("SELECT * FROM claude_sessions WHERE cwd = ?");
  return stmt.all(cwd);
}

// Backfill: copy rows from claude.db into pipeline.db.claude_sessions
// Safe to re-run: uses INSERT OR REPLACE, preserves started_at for existing sessions
export function backfillFromClaudeDb(db, claudeDbPath) {
  if (claudeDbPath.includes("'")) {
    throw new Error(`claudeDbPath must not contain single quotes: ${claudeDbPath}`);
  }
  db.exec(`ATTACH DATABASE '${claudeDbPath}' AS claude_attached`);
  try {
    db.exec("BEGIN");
    try {
      db.exec(`
        INSERT OR REPLACE INTO claude_sessions (session_id, cwd, started_at, user_ts, summary)
        SELECT session_id, cwd, started_at, user_ts, summary
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
