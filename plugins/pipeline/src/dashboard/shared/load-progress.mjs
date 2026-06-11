// Canonical session -> progress-map key. The progress map is built keyed by
// session.correlation_id (see loadProgressBySlug + its call sites); every
// renderer that looks the value up must use this helper so TUI / web / future
// surfaces stay in lock-step. Returns "" for sessions without a correlation_id
// (e.g. just-spawned, not yet wired up); those naturally miss the lookup and
// render 0/0, which is correct.
export function progressKey(session) {
  return session?.correlation_id || "";
}

// For each active session (by session.correlation_id), compute step/total from
// progress_steps grouped by state into the {done, inprog, todo, total,
// step} shape the agents panel renders.
export function loadProgressBySlug(db, slugs) {
  if (!Array.isArray(slugs) || slugs.length === 0) return {};
  const out = {};
  const stmt = db.prepare(`
    SELECT state, COUNT(*) AS c FROM progress_steps WHERE slug = ? GROUP BY state
  `);
  for (const slug of slugs) {
    let done = 0, inprog = 0, todo = 0;
    for (const row of stmt.all(slug)) {
      if (row.state === "completed") done = row.c;
      else if (row.state === "in_progress") inprog = row.c;
      else if (row.state === "pending") todo = row.c;
    }
    const total = done + inprog + todo;
    const step  = done + (inprog ? 1 : 0);
    out[slug] = { done, inprog, todo, total, step };
  }
  return out;
}
