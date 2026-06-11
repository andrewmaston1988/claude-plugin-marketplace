// pipeline_rows table — all functions take `project` as the leading argument
// after the db handle. Project + feature is the composite primary key.

export function rowGet(db, project, feature) {
  return db.prepare(
    "SELECT * FROM pipeline_rows WHERE project = ? AND feature = ?"
  ).get(project, feature) ?? null;
}

export function rowsList(db, project, { excludeStages = null, featureFilter = null } = {}) {
  let query = "SELECT * FROM pipeline_rows WHERE project = ?";
  const params = [project];

  if (excludeStages && excludeStages.length > 0) {
    query += ` AND stage NOT IN (${excludeStages.map(() => "?").join(",")})`;
    params.push(...excludeStages);
  }
  if (featureFilter) {
    query += " AND feature LIKE ?";
    params.push(featureFilter);
  }
  query += " ORDER BY rowid";

  return db.prepare(query).all(...params);
}

export function rowAdd(db, project, {
  feature, planFile, stage,
  branch = "—",
  rModel = null, dModel = null, qModel = null,
  rvwModel = null,
  sessionType = null, sessionFile = null, budgetUsd = null,
  dependsOn = null, targetBranch = "main",
  reviewRetries = null, reviewRetryBudget = null, reviewVerdict = null,
  prTitle = null,
  waitsOn = null, baseBranch = null,
} = {}) {
  const cols = [
    "project", "feature", "plan_file", "stage", "branch",
    "r_model", "d_model", "q_model",
    "session_type", "session_file", "budget_usd",
    "depends_on", "target_branch",
  ];
  const vals = [
    project, feature, planFile, stage, branch,
    rModel, dModel, qModel,
    sessionType, sessionFile, budgetUsd,
    dependsOn ?? null, targetBranch,
  ];

  if (rvwModel !== null)         { cols.push("rvw_model");           vals.push(rvwModel); }
  if (reviewRetries !== null)    { cols.push("review_retries");      vals.push(reviewRetries); }
  if (reviewRetryBudget !== null){ cols.push("review_retry_budget"); vals.push(reviewRetryBudget); }
  if (reviewVerdict !== null)    { cols.push("review_verdict");      vals.push(reviewVerdict); }
  if (prTitle !== null)          { cols.push("pr_title");            vals.push(prTitle); }
  if (waitsOn !== null)          { cols.push("waits_on");            vals.push(waitsOn); }
  if (baseBranch !== null)       { cols.push("base_branch");         vals.push(baseBranch); }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO pipeline_rows (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`
    ).run(...vals);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

export function rowUpdate(db, project, feature, fields = {}) {
  if (!fields || Object.keys(fields).length === 0) {
    return rowGet(db, project, feature) !== null;
  }

  const allFields = { ...fields, updated_at: "CURRENT_TIMESTAMP" };
  const setParts = [];
  const params = [];

  for (const [k, v] of Object.entries(allFields)) {
    if (v === "CURRENT_TIMESTAMP") {
      setParts.push(`${k} = CURRENT_TIMESTAMP`);
    } else {
      setParts.push(`${k} = ?`);
      params.push(v);
    }
  }
  params.push(project, feature);

  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(
      `UPDATE pipeline_rows SET ${setParts.join(", ")} WHERE project = ? AND feature = ?`
    ).run(...params);
    db.exec("COMMIT");
    return result.changes > 0;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

export function rowDelete(db, project, feature) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(
      "DELETE FROM pipeline_rows WHERE project = ? AND feature = ?"
    ).run(project, feature);
    db.exec("COMMIT");
    return result.changes > 0;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

// Sister to autoRequeueDevFromReview — test-stage bounce.
export function autoRequeueDev(db, project, feature, newRetryCount) {
  return rowUpdate(db, project, feature, { stage: "queued", dev_retries: newRetryCount });
}

// CAS bounce-back from review → dev on needs_work.
// Predicate: WHERE project=? AND feature=? AND review_retries=expectedRetries.
// Returns false if a concurrent caller already incremented review_retries.
export function autoRequeueDevFromReview(db, project, feature, expectedRetries) {
  const result = db.prepare(`
    UPDATE pipeline_rows
       SET stage          = 'queued',
           notes_extra    = 'type=dev',
           review_retries = review_retries + 1,
           review_verdict = NULL,
           updated_at     = CURRENT_TIMESTAMP
     WHERE project        = ?
       AND feature        = ?
       AND review_retries = ?
  `).run(project, feature, expectedRetries);
  return result.changes === 1;
}

export function resetDevRetries(db, project, feature) {
  return rowUpdate(db, project, feature, { dev_retries: 0 });
}

export function setLastError(db, project, feature, msg) {
  return rowUpdate(db, project, feature, { last_error: msg });
}

export function clearLastError(db, project, feature) {
  return rowUpdate(db, project, feature, { last_error: null });
}
