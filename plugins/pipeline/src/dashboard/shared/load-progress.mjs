// For each active session (by session_file slug), compute step/total from
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
