import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

// Validate name shape; return error message or null.
export function validateProjectName(name) {
  if (!name)                       return "name required";
  if (!NAME_RE.test(name))         return "name must match /^[a-z0-9][a-z0-9_-]*$/";
  return null;
}

// Validate root_path: must exist, be a directory, contain .git.
export function validateProjectPath(rootPath) {
  if (!rootPath)                       return "root_path required";
  if (!existsSync(rootPath))           return `path does not exist: ${rootPath}`;
  try {
    if (!statSync(rootPath).isDirectory()) return `not a directory: ${rootPath}`;
  } catch (e) {
    return `cannot stat: ${e.message}`;
  }
  if (!existsSync(join(rootPath, ".git"))) return `not a git repo (no .git): ${rootPath}`;
  return null;
}

// Insert a project. Returns the inserted row or null on validation failure
// (with the error message thrown as Error — callers surface to user).
export function projectAdd(db, { name, rootPath, enabled = 1 }) {
  const nameErr = validateProjectName(name);
  if (nameErr) throw new Error(nameErr);
  const pathErr = validateProjectPath(rootPath);
  if (pathErr) throw new Error(pathErr);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO projects (name, root_path, enabled) VALUES (?, ?, ?)"
    ).run(name, rootPath, enabled);
    db.exec("COMMIT");
    return projectGetByName(db, name);
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    if (String(e.message).includes("UNIQUE")) {
      throw new Error(
        `project already registered (name='${name}' or path collides)`
      );
    }
    throw e;
  }
}

export function projectList(db) {
  return db.prepare(
    "SELECT name, root_path, enabled, created_at FROM projects ORDER BY name"
  ).all();
}

export function projectGetByName(db, name) {
  return db.prepare(
    "SELECT name, root_path, enabled, created_at FROM projects WHERE name = ?"
  ).get(name) ?? null;
}

export function projectGetByPath(db, rootPath) {
  return db.prepare(
    "SELECT name, root_path, enabled, created_at FROM projects WHERE root_path = ?"
  ).get(rootPath) ?? null;
}

// Set enabled=1|0 for the named project. Returns true if a row was updated.
export function projectSetEnabled(db, name, enabled) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(
      "UPDATE projects SET enabled = ? WHERE name = ?"
    ).run(enabled ? 1 : 0, name);
    db.exec("COMMIT");
    return result.changes > 0;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

// Remove a project. Without --purge, fails loudly if rows exist for this project.
// With --purge, cascades deletes to pipeline_rows, progress_files (and progress_steps
// via ON DELETE CASCADE), sessions, pipeline_meta, session_spawn_map.
export function projectRemove(db, name, { purge = false } = {}) {
  const row = projectGetByName(db, name);
  if (!row) return false;

  db.exec("BEGIN IMMEDIATE");
  try {
    if (purge) {
      db.prepare("DELETE FROM pipeline_rows     WHERE project = ?").run(name);
      db.prepare("DELETE FROM progress_files    WHERE project = ?").run(name);
      db.prepare("DELETE FROM sessions          WHERE project = ?").run(name);
      db.prepare("DELETE FROM pipeline_meta     WHERE project = ?").run(name);
      db.prepare("DELETE FROM session_spawn_map WHERE project = ?").run(name);
    } else {
      const counts = {
        rows:     db.prepare("SELECT COUNT(*) AS c FROM pipeline_rows  WHERE project = ?").get(name).c,
        progress: db.prepare("SELECT COUNT(*) AS c FROM progress_files WHERE project = ?").get(name).c,
        sessions: db.prepare("SELECT COUNT(*) AS c FROM sessions       WHERE project = ?").get(name).c,
      };
      const total = counts.rows + counts.progress + counts.sessions;
      if (total > 0) {
        db.exec("ROLLBACK");
        throw new Error(
          `project '${name}' has ${counts.rows} row(s), ${counts.progress} progress, ` +
          `${counts.sessions} session(s); pass --purge to cascade-delete`
        );
      }
    }
    db.prepare("DELETE FROM projects WHERE name = ?").run(name);
    db.exec("COMMIT");
    return true;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

// Orchestrator entry point: return Map<projectName, rootPath> of enabled projects.
export function listEnabledProjects(db) {
  const out = new Map();
  const rows = db.prepare(
    "SELECT name, root_path FROM projects WHERE enabled = 1 ORDER BY name"
  ).all();
  for (const r of rows) out.set(r.name, r.root_path);
  return out;
}
