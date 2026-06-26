// progress_files / progress_steps — slug is globally unique (corr_id-based) so
// most operations key on slug alone. Functions that filter by project take the
// `project` arg explicitly.

export function progressCreate(db, project, { slug, steps, parentSlug = null, prefix = null, pid = null, sessionType = null }) {
  if (!project) throw new Error("progressCreate: project required");
  db.exec("BEGIN IMMEDIATE");
  try {
    // Clear soft-deleted rows with this slug so re-creation works cleanly.
    db.prepare(
      "DELETE FROM progress_steps WHERE slug = ? AND slug IN " +
      "(SELECT slug FROM progress_files WHERE is_active = 0)"
    ).run(slug);
    db.prepare(
      "DELETE FROM progress_files WHERE slug = ? AND is_active = 0"
    ).run(slug);

    db.prepare(
      "INSERT INTO progress_files (slug, project, parent_slug, prefix, pid, session_type, is_active, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
    ).run(slug, project, parentSlug, prefix, pid, sessionType, 1);

    for (let i = 0; i < steps.length; i++) {
      db.prepare(
        "INSERT INTO progress_steps (slug, step_index, content, state) VALUES (?, ?, ?, 'pending')"
      ).run(slug, i + 1, steps[i]);
    }

    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

export function progressGet(db, slug) {
  const row = db.prepare("SELECT * FROM progress_files WHERE slug = ?").get(slug);
  if (!row) return null;

  const steps = db.prepare(
    "SELECT step_index, content, state FROM progress_steps WHERE slug = ? ORDER BY step_index"
  ).all(slug);

  return {
    slug: row.slug,
    project: row.project ?? null,
    parent: row.parent_slug ?? null,
    prefix: row.prefix ?? null,
    steps: steps.map(s => ({ index: s.step_index, text: s.content, state: s.state })),
  };
}

export function progressMark(db, slug, index, state) {
  const dbState = state === "inprogress" ? "in_progress" : "completed";

  db.exec("BEGIN IMMEDIATE");
  try {
    const count = db.prepare(
      "SELECT COUNT(*) AS c FROM progress_steps WHERE slug = ? AND step_index = ?"
    ).get(slug, index);
    if (!count || count.c === 0) {
      db.exec("ROLLBACK");
      throw new Error(`Step index ${index} out of range for ${slug}`);
    }
    db.prepare(
      "UPDATE progress_steps SET state = ? WHERE slug = ? AND step_index = ?"
    ).run(dbState, slug, index);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

export function progressDelete(db, slug) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const fileRow = db.prepare(
      "SELECT parent_slug FROM progress_files WHERE slug = ?"
    ).get(slug);

    if (!fileRow) {
      db.exec("COMMIT");
      return "OK";
    }

    const parentSlug = fileRow.parent_slug ?? null;

    db.prepare(
      "UPDATE progress_files SET is_active = 0, completed_at = CURRENT_TIMESTAMP WHERE slug = ?"
    ).run(slug);

    let cascadeStatus = null;

    if (parentSlug) {
      const parentRow = db.prepare(
        "SELECT * FROM progress_files WHERE is_active = 1 AND slug LIKE ? AND slug != ? " +
        "ORDER BY created_at DESC LIMIT 1"
      ).get(`%${parentSlug}%`, slug);

      if (parentRow) {
        const parentSteps = db.prepare(
          "SELECT step_index, content FROM progress_steps WHERE slug = ? ORDER BY step_index"
        ).all(parentRow.slug);

        const matches = parentSteps.filter(s => s.content.includes(slug));

        if (matches.length === 1) {
          db.prepare(
            "UPDATE progress_steps SET state = 'completed' WHERE slug = ? AND step_index = ?"
          ).run(parentRow.slug, matches[0].step_index);
          cascadeStatus = "OK (parent step marked done)";
        } else if (matches.length > 1) {
          const lastInProgress = db.prepare(
            "SELECT step_index FROM progress_steps WHERE slug = ? AND state = 'in_progress' " +
            "ORDER BY step_index DESC LIMIT 1"
          ).get(parentRow.slug);
          if (lastInProgress) {
            db.prepare(
              "UPDATE progress_steps SET state = 'completed' WHERE slug = ? AND step_index = ?"
            ).run(parentRow.slug, lastInProgress.step_index);
            cascadeStatus = `WARN: multiple parent steps reference ${slug}; fell back to last in-progress step`;
          }
        }
      }
    }

    db.exec("COMMIT");
    return cascadeStatus ?? "OK";
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

// Active progress files: optionally filter to a single project. With project=null,
// returns active progress across the entire registry (replaces the old filesystem-scan
// progressListActiveAcrossProjects).
export function progressListActive(db, { project = null } = {}) {
  if (project) {
    return db.prepare(
      "SELECT * FROM progress_files WHERE is_active = 1 AND project = ? ORDER BY created_at DESC"
    ).all(project);
  }
  return db.prepare(
    "SELECT * FROM progress_files WHERE is_active = 1 ORDER BY created_at DESC"
  ).all();
}

export function progressResumeIndex(db, slug) {
  const row = db.prepare(
    "SELECT step_index FROM progress_steps WHERE slug = ? AND state IN ('in_progress', 'pending') " +
    "ORDER BY step_index LIMIT 1"
  ).get(slug);
  return row ? row.step_index : 0;
}

export function hasActiveSession(db, project) {
  const row = db.prepare(
    "SELECT slug, pid FROM progress_files WHERE project = ? AND is_active = 1 LIMIT 1"
  ).get(project);
  return row ? [row.slug, row.pid] : null;
}

export function progressMdString(db, slug) {
  const parsed = progressGet(db, slug);
  if (!parsed) return null;

  const lines = [`# progress: ${parsed.slug}\n`];
  if (parsed.parent) lines.push(`# parent: ${parsed.parent}\n`);
  if (parsed.prefix) lines.push(`# prefix: ${parsed.prefix}\n`);
  lines.push("\n");

  for (const step of parsed.steps) {
    const marker = step.state === "in_progress" ? "[~]" : step.state === "completed" ? "[x]" : "[ ]";
    lines.push(`${marker} ${step.text}\n`);
  }
  return lines.join("");
}

export function progressSetPid(db, slug, pid) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE progress_files SET pid = ? WHERE slug = ?").run(Number(pid), slug);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

export function progressNoteAppend(db, slug, text) {
  const stamp = new Date().toISOString().slice(0, 19) + "+00:00";
  const line = `[${stamp}] ${text}`.trimEnd();

  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT notes FROM progress_files WHERE slug = ?").get(slug);
    if (!row) { db.exec("COMMIT"); return; }
    const existing = row.notes ?? "";
    const newValue = existing ? existing + "\n" + line : line;
    db.prepare("UPDATE progress_files SET notes = ? WHERE slug = ?").run(newValue, slug);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

export function progressLastInProgressStep(db, slugOrSubstring) {
  const row = db.prepare(`
    SELECT s.content
      FROM progress_steps s
      JOIN progress_files f ON f.slug = s.slug
     WHERE f.is_active = 1
       AND s.state = 'in_progress'
       AND (f.slug = ? OR f.slug LIKE ?)
     ORDER BY f.created_at DESC, s.step_index DESC
     LIMIT 1
  `).get(slugOrSubstring, `%${slugOrSubstring}%`);
  return row ? row.content : null;
}

export function progressFindParentBySlugSubstring(db, parentSubstring, excludeSlug = null) {
  if (excludeSlug) {
    const row = db.prepare(
      "SELECT * FROM progress_files WHERE is_active = 1 AND slug LIKE ? AND slug != ? " +
      "ORDER BY created_at DESC LIMIT 1"
    ).get(`%${parentSubstring}%`, excludeSlug);
    return row ?? null;
  }
  const row = db.prepare(
    "SELECT * FROM progress_files WHERE is_active = 1 AND slug LIKE ? " +
    "ORDER BY created_at DESC LIMIT 1"
  ).get(`%${parentSubstring}%`);
  return row ?? null;
}

// Cross-project active progress — registry-wide. Replaces the old filesystem-scan
// progressListActiveAcrossProjects(reposRoot) which is no longer meaningful under
// the unified DB.
export function progressListActiveAcrossProjects(db) {
  const rows = db.prepare(
    "SELECT * FROM progress_files WHERE is_active = 1 ORDER BY created_at DESC"
  ).all();
  const out = [];
  for (const row of rows) {
    const steps = db.prepare(
      "SELECT step_index, content, state FROM progress_steps WHERE slug = ? ORDER BY step_index"
    ).all(row.slug);
    out.push({
      project: row.project ?? null,
      slug: row.slug,
      parent: row.parent_slug ?? null,
      prefix: row.prefix ?? null,
      pid: row.pid ?? null,
      session_type: row.session_type ?? null,
      notes: row.notes ?? null,
      created_at: row.created_at ?? null,
      steps: steps.map(s => ({ index: s.step_index, text: s.content, state: s.state })),
    });
  }
  return out;
}
