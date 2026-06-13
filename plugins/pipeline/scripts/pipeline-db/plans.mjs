export function planUpsert(db, { project, slug, filePath, status = 'active', branch, title, body }) {
  const stmt = db.prepare(`
    INSERT INTO plans (project, slug, file_path, status, branch, title, body, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(project, slug) DO UPDATE SET
      file_path = excluded.file_path,
      status = excluded.status,
      branch = excluded.branch,
      title = excluded.title,
      body = excluded.body,
      indexed_at = CURRENT_TIMESTAMP
  `);
  stmt.run(project, slug, filePath, status, branch, title, body);
}

export function planSetStatus(db, project, slug, status) {
  const stmt = db.prepare(`
    UPDATE plans
    SET status = ?, indexed_at = CURRENT_TIMESTAMP
    WHERE project = ? AND slug = ?
  `);
  stmt.run(status, project, slug);
}

export function planGet(db, project, slug) {
  const stmt = db.prepare(`
    SELECT * FROM plans
    WHERE project = ? AND slug = ?
  `);
  return stmt.get(project, slug);
}

export function plansList(db, { project, status } = {}) {
  let query = 'SELECT * FROM plans WHERE 1=1';
  const params = [];

  if (project) {
    query += ' AND project = ?';
    params.push(project);
  }
  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY project, slug';
  const stmt = db.prepare(query);
  return stmt.all(...params);
}

export function plansSearch(db, query) {
  const stmt = db.prepare(`
    SELECT p.project, p.slug, p.title, p.status
    FROM plans_fts
    JOIN plans p ON plans_fts.rowid = p.rowid
    WHERE plans_fts MATCH ?
    ORDER BY p.project, p.slug
  `);
  return stmt.all(query);
}

export function plansFtsRebuild(db) {
  const stmt = db.prepare(`
    INSERT INTO plans_fts(plans_fts) VALUES('rebuild')
  `);
  stmt.run();
}
