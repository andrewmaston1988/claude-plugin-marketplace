// Steps 0b + 9 — progress file lifecycle.
// Mirrors merge.py: step_0b_progress, step_9_cleanup.
import { progressCreate, progressGet, progressDelete } from "../../../scripts/pipeline-db/index.mjs";

const MERGE_STEPS = [
  "Step 0a — Rebase branches on main",
  "Step 1 — Identify plan files",
  "Step 2 — Verify definition of done",
  "Step 3 — Update plan Current Status",
  "Step 4 — Update documentation",
  "Step 5 — Squash merge to target branch",
  "Step 6 — Move plans to complete/",
  "Step 7 — Commit project",
  "Step 8 — Smoke check",
  "Step 9 — Clean up progress file",
];

export function step0bProgress(db, project, sessionSlug, parent = null) {
  const existing = progressGet(db, sessionSlug);
  if (existing) {
    process.stdout.write(`[0b] Resuming existing progress entry for ${sessionSlug}\n`);
    return;
  }
  progressCreate(db, project, {
    slug: sessionSlug,
    steps: MERGE_STEPS,
    parentSlug: parent,
    prefix: "merge",
  });
  process.stdout.write(`[0b] Created progress ${sessionSlug}\n`);
}

export function step9Cleanup(db, sessionSlug) {
  const result = progressDelete(db, sessionSlug);
  process.stdout.write(`[9] progress-delete: ${result}\n`);
}
