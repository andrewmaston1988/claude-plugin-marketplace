// Global key/value state — orchestrator_state and circuit_breaker_state are
// truly global (single orchestrator process, single breaker per machine), so
// keep the (key, value) shape unchanged.

export function stateGet(db, table, key) {
  const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key);
  return row ? row.value : null;
}

export function stateSet(db, table, key, value) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT OR REPLACE INTO ${table} (key, value) VALUES (?, ?)`).run(key, value);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

export function stateDump(db, table) {
  const rows = db.prepare(`SELECT key, value FROM ${table}`).all();
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

// pipeline_meta is per-project (composite PK on project, key). Most common use:
// pipeline_enabled flag, per-project knobs.

export function getMeta(db, project, key) {
  if (!project) throw new Error("getMeta: project required");
  try {
    const row = db.prepare(
      "SELECT value FROM pipeline_meta WHERE project = ? AND key = ?"
    ).get(project, key);
    return row ? row.value : null;
  } catch {
    return null;
  }
}

export function setMeta(db, project, key, value) {
  if (!project) throw new Error("setMeta: project required");
  db.prepare(
    "INSERT INTO pipeline_meta (project, key, value) VALUES (?, ?, ?) " +
    "ON CONFLICT(project, key) DO UPDATE SET value = excluded.value"
  ).run(project, key, value);
}
