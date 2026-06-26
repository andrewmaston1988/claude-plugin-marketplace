export function sessionRecordSpawn(db, { correlationId, project, feature, sessionType, cwd, sessionFile, pid }) {
  const spawnTime = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO sessions (correlation_id, project, feature, session_type, cwd, session_file, spawn_time, pid, is_active) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)"
    ).run(correlationId, project, feature, sessionType, cwd, sessionFile, spawnTime, pid);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

export function sessionSetId(db, correlationId, sessionId) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE sessions SET session_id = ? WHERE correlation_id = ?").run(sessionId, correlationId);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

export function sessionFinish(db, correlationId) {
  const finishedAt = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "UPDATE sessions SET is_active = 0, finished_at = ? WHERE correlation_id = ?"
    ).run(finishedAt, correlationId);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

export function sessionsActive(db, project = null) {
  if (project) {
    return db.prepare(
      "SELECT * FROM sessions WHERE is_active = 1 AND project = ? ORDER BY spawn_time DESC"
    ).all(project);
  }
  return db.prepare(
    "SELECT * FROM sessions WHERE is_active = 1 ORDER BY spawn_time DESC"
  ).all();
}

// Checks sessions table first (preferred), falls back to progress_files.is_active (legacy).
export function projectHasActiveSession(db, project) {
  const sessionRow = db.prepare(
    "SELECT * FROM sessions WHERE is_active = 1 AND project = ? LIMIT 1"
  ).get(project);
  if (sessionRow) return sessionRow;

  const progressRow = db.prepare(
    "SELECT * FROM progress_files WHERE is_active = 1 AND feature_project = ? LIMIT 1"
  ).get(project);
  return progressRow ?? null;
}

export function countActiveSessions(db) {
  const result = db.prepare(
    "SELECT COUNT(*) as count FROM sessions WHERE is_active = 1"
  ).get();
  return result?.count ?? 0;
}

export function featureIsActive(db, project, feature) {
  return !!db.prepare(
    "SELECT 1 FROM sessions WHERE project = ? AND feature = ? AND is_active = 1 LIMIT 1"
  ).get(project, feature);
}
