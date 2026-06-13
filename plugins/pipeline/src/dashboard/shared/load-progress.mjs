// Slice steps into a viewport: last completed + in_progress + upcoming pending,
// capped at `cap`. Returns { visible, overflow, overflowDone } where overflowDone
// is the count of completed steps hidden above the window (used for "+N more (M done)" label).
export function sliceSteps(steps, cap = 4) {
  if (!steps || steps.length === 0) return { visible: [], overflow: 0, overflowDone: 0 };
  const lastDone = [...steps].reverse().find(s => s.state === "completed");
  const inprog   = steps.find(s => s.state === "in_progress");
  const pending  = steps.filter(s => s.state === "pending");
  const visible  = [];
  if (lastDone) visible.push(lastDone);
  if (inprog)   visible.push(inprog);
  visible.push(...pending.slice(0, cap - visible.length));
  const shown = visible.slice(0, cap);
  const overflow = Math.max(0, steps.length - shown.length);
  const completedCount = steps.filter(s => s.state === "completed").length;
  const shownDone = shown.filter(s => s.state === "completed").length;
  const overflowDone = Math.max(0, completedCount - shownDone);
  return { visible: shown, overflow, overflowDone };
}

// Full step list for one slug, ordered by step_index.
export function loadStepsBySlug(db, slug) {
  if (!slug) return [];
  return db.prepare(
    `SELECT content AS text, state FROM progress_steps WHERE slug = ? ORDER BY step_index`
  ).all(slug);
}

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
