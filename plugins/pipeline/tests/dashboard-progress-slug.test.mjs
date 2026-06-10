// Dashboard progress lookup — verify that correlation_id (not session_file basename) is used as the slug key
import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectPath, close, projectAdd, progressCreate } from "../scripts/pipeline-db/index.mjs";
import { sessionRecordSpawn } from "../scripts/pipeline-db/sessions.mjs";
import { loadActiveSessions } from "../src/dashboard/shared/load-sessions.mjs";
import { loadProgressBySlug } from "../src/dashboard/shared/load-progress.mjs";

const PROJECT = "testproject";

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "dashboard-progress-slug-"));
  const dbPath = join(tmp, "pipeline.db");
  const repo = join(tmp, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const db = connectPath(dbPath);
  projectAdd(db, { name: PROJECT, rootPath: repo });
  return { tmp, db };
}

function teardown(tmp, db) {
  try { close(db); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

test("loadProgressBySlug — progress keyed by correlation_id, not session_file basename", () => {
  const { tmp, db } = setup();
  const repo = join(tmp, "repo");
  try {
    const correlationId = "test-session-20260610T123456Z";
    const sessionFile = "dev-2026-06-10-some-feature.md";

    // Create a progress entry keyed by correlation_id
    progressCreate(db, PROJECT, {
      slug: correlationId,
      steps: ["step1", "step2", "step3"],
      sessionType: "dev",
    });

    // Mark some steps as in_progress/completed to verify it was recorded
    db.prepare("UPDATE progress_steps SET state = 'completed' WHERE slug = ? AND step_index = 1")
      .run(correlationId);
    db.prepare("UPDATE progress_steps SET state = 'in_progress' WHERE slug = ? AND step_index = 2")
      .run(correlationId);

    // Add a session with correlation_id
    sessionRecordSpawn(db, {
      correlationId,
      project: PROJECT,
      feature: "some-feature",
      sessionType: "dev",
      cwd: repo,
      sessionFile,
      pid: null,
    });

    // Load sessions and verify correlation_id is available
    const sessions = loadActiveSessions(db, PROJECT);
    equal(sessions.length, 1);
    equal(sessions[0].correlation_id, correlationId);

    // Load progress using correlation_id (correct approach)
    const progressByCorrelation = loadProgressBySlug(db, [correlationId]);
    deepEqual(progressByCorrelation[correlationId], {
      done: 1,
      inprog: 1,
      todo: 1,
      total: 3,
      step: 2,
    });

    // Load progress using session_file basename (incorrect approach — would be empty)
    const basenameSlugs = [(sessionFile || "").split(/[\\/]/).pop().replace(/\.md$/, "")];
    const progressByBasename = loadProgressBySlug(db, basenameSlugs);
    deepEqual(progressByBasename[basenameSlugs[0]], { done: 0, inprog: 0, todo: 0, total: 0, step: 0 });
  } finally { teardown(tmp, db); }
});

test("loadProgressBySlug — filters out sessions with null correlation_id", () => {
  const { tmp, db } = setup();
  const repo = join(tmp, "repo");
  try {
    const correlationId = "active-session-20260610T123456Z";

    // Create progress for one session
    progressCreate(db, PROJECT, {
      slug: correlationId,
      steps: ["step1"],
      sessionType: "dev",
    });
    db.prepare("UPDATE progress_steps SET state = 'completed' WHERE slug = ?")
      .run(correlationId);

    // Add a session with correlation_id
    sessionRecordSpawn(db, {
      correlationId,
      project: PROJECT,
      feature: "feature-1",
      sessionType: "dev",
      cwd: repo,
      sessionFile: "dev-2026-06-10-feature-1.md",
      pid: null,
    });

    // Add a session without correlation_id (edge case — should be skipped)
    // sessionRecordSpawn always sets correlation_id, so we test by inserting directly
    db.prepare(
      "INSERT INTO sessions (correlation_id, project, feature, session_type, cwd, session_file, spawn_time, pid, is_active) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)"
    ).run(null, PROJECT, "feature-2", "dev", repo, "dev-2026-06-10-feature-2.md", new Date().toISOString(), null);

    const sessions = loadActiveSessions(db, PROJECT);
    equal(sessions.length, 2);

    // Only load progress for sessions with correlation_id
    const validSlugs = sessions.filter(s => s.correlation_id).map(s => s.correlation_id);
    equal(validSlugs.length, 1);
    equal(validSlugs[0], correlationId);

    const progress = loadProgressBySlug(db, validSlugs);
    equal(progress[correlationId].done, 1);
  } finally { teardown(tmp, db); }
});
