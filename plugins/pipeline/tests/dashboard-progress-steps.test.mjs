import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectPath, close, projectAdd, progressCreate } from "../src/db/index.mjs";
import { loadStepsBySlug, sliceSteps } from "../src/dashboard/shared/load-progress.mjs";

const PROJECT = "testproject";

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "dashboard-progress-steps-"));
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

// --- loadStepsBySlug ---

test("loadStepsBySlug — ordered by step_index", () => {
  const { tmp, db } = setup();
  try {
    const slug = "test-order-slug";
    progressCreate(db, PROJECT, { slug, steps: [] });
    // Insert steps out of order by step_index
    db.prepare("INSERT INTO progress_steps (slug, step_index, content, state) VALUES (?, 3, 'gamma', 'pending')").run(slug);
    db.prepare("INSERT INTO progress_steps (slug, step_index, content, state) VALUES (?, 1, 'alpha', 'pending')").run(slug);
    db.prepare("INSERT INTO progress_steps (slug, step_index, content, state) VALUES (?, 2, 'beta', 'pending')").run(slug);
    const result = loadStepsBySlug(db, slug);
    deepEqual(result.map(r => r.text), ["alpha", "beta", "gamma"]);
  } finally { teardown(tmp, db); }
});

test("loadStepsBySlug — unknown slug returns []", () => {
  const { tmp, db } = setup();
  try {
    deepEqual(loadStepsBySlug(db, "no-such-slug"), []);
  } finally { teardown(tmp, db); }
});

// --- sliceSteps ---

test("sliceSteps — window with in_progress (cap 3)", () => {
  // 6 steps: 3 completed, 1 in_progress, 2 pending
  // cap=3 → visible=[lastDone, inprog, firstPending], overflow=3, overflowDone=2
  const steps = [
    { text: "a", state: "completed" },
    { text: "b", state: "completed" },
    { text: "c", state: "completed" },
    { text: "d", state: "in_progress" },
    { text: "e", state: "pending" },
    { text: "f", state: "pending" },
  ];
  const { visible, overflow, overflowDone } = sliceSteps(steps, 3);
  deepEqual(visible.map(s => s.text), ["c", "d", "e"]);
  equal(overflow, 3);
  equal(overflowDone, 2);
});

test("sliceSteps — no in_progress: last-completed + pending fill cap", () => {
  // 6 steps: 2 completed, 4 pending, default cap=4
  // visible=[lastDone, pend0, pend1, pend2], overflow=2
  const steps = [
    { text: "a", state: "completed" },
    { text: "b", state: "completed" },
    { text: "c", state: "pending" },
    { text: "d", state: "pending" },
    { text: "e", state: "pending" },
    { text: "f", state: "pending" },
  ];
  const { visible, overflow } = sliceSteps(steps);
  deepEqual(visible.map(s => s.text), ["b", "c", "d", "e"]);
  equal(overflow, 2);
});

test("sliceSteps — overflowDone counts hidden completed steps", () => {
  // Same 6-step (2 comp, 4 pending) case: only lastDone shown → overflowDone=1
  const steps = [
    { text: "a", state: "completed" },
    { text: "b", state: "completed" },
    { text: "c", state: "pending" },
    { text: "d", state: "pending" },
    { text: "e", state: "pending" },
    { text: "f", state: "pending" },
  ];
  const { overflowDone } = sliceSteps(steps);
  equal(overflowDone, 1);
});

test("sliceSteps — empty input", () => {
  deepEqual(sliceSteps([]), { visible: [], overflow: 0, overflowDone: 0 });
});

test("sliceSteps — no overflow when all steps fit", () => {
  // 3 steps (1 completed, 2 pending), cap=4 → all fit, overflow=0, overflowDone=0
  const steps = [
    { text: "a", state: "completed" },
    { text: "b", state: "pending" },
    { text: "c", state: "pending" },
  ];
  const { visible, overflow, overflowDone } = sliceSteps(steps, 4);
  deepEqual(visible.map(s => s.text), ["a", "b", "c"]);
  equal(overflow, 0);
  equal(overflowDone, 0);
});

test("sliceSteps — all completed: only lastDone shown, rest overflow", () => {
  // 6 steps all completed, cap=4 → visible=[lastDone], overflow=5, overflowDone=5
  const steps = [
    { text: "a", state: "completed" },
    { text: "b", state: "completed" },
    { text: "c", state: "completed" },
    { text: "d", state: "completed" },
    { text: "e", state: "completed" },
    { text: "f", state: "completed" },
  ];
  const { visible, overflow, overflowDone } = sliceSteps(steps, 4);
  deepEqual(visible.map(s => s.text), ["f"]);
  equal(overflow, 5);
  equal(overflowDone, 5);
});
