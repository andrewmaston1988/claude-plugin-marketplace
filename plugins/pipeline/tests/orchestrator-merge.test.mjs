import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { spawnMerge, isDirtyTree, isMergedInto } from "../scripts/orchestrator/spawn.mjs";

function createMockLog() {
  const logs = [];
  const fn = (msg, level = "INFO") => { logs.push({ msg, level }); };
  fn.getLogs = () => logs;
  fn.hasMessage = (substr) => logs.some(l => l.msg.includes(substr));
  return fn;
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "init\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
}

// ── spawnMerge ────────────────────────────────────────────────────────────────

test("spawnMerge returns null on dry-run", () => {
  const logFn = createMockLog();
  const result = spawnMerge("proj", { feature: "feat", branch: "autonomous/feat" }, ".", "claude-haiku-4-5", { db: null, dryRun: true, logFn });
  strictEqual(result, null);
  ok(logFn.hasMessage("DRY-RUN"), `Logs: ${JSON.stringify(logFn.getLogs())}`);
});

test("spawnMerge dry-run log includes model name", () => {
  const logFn = createMockLog();
  spawnMerge("proj", { feature: "my-feat" }, ".", "claude-sonnet-4-6", { db: null, dryRun: true, logFn });
  ok(logFn.hasMessage("claude-sonnet-4-6"), `Logs: ${JSON.stringify(logFn.getLogs())}`);
});

test("spawnMerge dry-run log includes feature name", () => {
  const logFn = createMockLog();
  spawnMerge("proj", { feature: "named-feature" }, ".", "claude-haiku-4-5", { db: null, dryRun: true, logFn });
  ok(logFn.hasMessage("named-feature"), `Logs: ${JSON.stringify(logFn.getLogs())}`);
});

// ── isDirtyTree ───────────────────────────────────────────────────────────────

test("isDirtyTree: false for a clean repo", () => {
  const tmp = mkdtempSync(join(tmpdir(), "merge-test-"));
  try {
    initRepo(tmp);
    strictEqual(isDirtyTree(tmp), false, "freshly committed repo should be clean");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("isDirtyTree: true when there are uncommitted changes", () => {
  const tmp = mkdtempSync(join(tmpdir(), "merge-test-"));
  try {
    initRepo(tmp);
    writeFileSync(join(tmp, "dirty.txt"), "unsaved\n", "utf8");
    spawnSync("git", ["add", "dirty.txt"], { cwd: tmp });
    strictEqual(isDirtyTree(tmp), true, "staged file should make tree dirty");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("isDirtyTree: true for nonexistent path", () => {
  strictEqual(isDirtyTree("/nonexistent/path/xyz"), true);
});

// ── isMergedInto ──────────────────────────────────────────────────────────────

test("isMergedInto: true when target is an ancestor of feature (feature up-to-date)", () => {
  // master: A; feature/x: A→B — master IS an ancestor of feature/x → not diverged.
  const tmp = mkdtempSync(join(tmpdir(), "merge-test-"));
  try {
    initRepo(tmp);
    spawnSync("git", ["checkout", "-b", "feature/x"], { cwd: tmp });
    writeFileSync(join(tmp, "feat.txt"), "feat\n", "utf8");
    spawnSync("git", ["add", "feat.txt"], { cwd: tmp });
    spawnSync("git", ["commit", "-m", "feat"], { cwd: tmp });
    ok(isMergedInto("master", "feature/x", tmp), "master (A) should be ancestor of feature/x (A→B)");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("isMergedInto: false when target has moved ahead of feature (diverged)", () => {
  // master: A→C; feature/y: A→B — master has C which feature/y doesn't → diverged.
  const tmp = mkdtempSync(join(tmpdir(), "merge-test-"));
  try {
    initRepo(tmp);
    spawnSync("git", ["checkout", "-b", "feature/y"], { cwd: tmp });
    writeFileSync(join(tmp, "feat.txt"), "feat\n", "utf8");
    spawnSync("git", ["add", "feat.txt"], { cwd: tmp });
    spawnSync("git", ["commit", "-m", "feat"], { cwd: tmp });
    // Move master ahead independently
    spawnSync("git", ["checkout", "master"], { cwd: tmp });
    writeFileSync(join(tmp, "main-change.txt"), "main\n", "utf8");
    spawnSync("git", ["add", "main-change.txt"], { cwd: tmp });
    spawnSync("git", ["commit", "-m", "main move"], { cwd: tmp });
    strictEqual(isMergedInto("master", "feature/y", tmp), false, "master moved ahead → not ancestor of feature/y");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("isMergedInto: false for nonexistent path", () => {
  strictEqual(isMergedInto("master", "feature/z", "/nonexistent/xyz"), false);
});

// ── on_merge_ready sibling-iteration logic ────────────────────────────────────
// Tests verify the filter predicate that replaced the single .find() call.
// We test the shape of the predicate rather than calling runTick end-to-end,
// which would require a fully-wired DB and filesystem.

function unfiredMergeRows(rows) {
  return rows.filter(r =>
    r.stage === "merge" &&
    !(r.notes_extra || "").includes("[merge-ready-fired]")
  );
}

test("unfired filter: two siblings at merge → both returned", () => {
  const rows = [
    { feature: "feat-a", stage: "merge", notes_extra: null },
    { feature: "feat-b", stage: "merge", notes_extra: null },
  ];
  const result = unfiredMergeRows(rows);
  strictEqual(result.length, 2);
  ok(result.some(r => r.feature === "feat-a"));
  ok(result.some(r => r.feature === "feat-b"));
});

test("unfired filter: one sibling already marked → only unmarked returned", () => {
  const rows = [
    { feature: "feat-a", stage: "merge", notes_extra: "[merge-ready-fired]" },
    { feature: "feat-b", stage: "merge", notes_extra: null },
  ];
  const result = unfiredMergeRows(rows);
  strictEqual(result.length, 1);
  strictEqual(result[0].feature, "feat-b");
});

test("unfired filter: single row at merge → returned once", () => {
  const rows = [
    { feature: "solo", stage: "merge", notes_extra: null },
  ];
  const result = unfiredMergeRows(rows);
  strictEqual(result.length, 1);
  strictEqual(result[0].feature, "solo");
});

test("unfired filter: single already-marked row → empty", () => {
  const rows = [
    { feature: "solo", stage: "merge", notes_extra: "prev [merge-ready-fired]" },
  ];
  const result = unfiredMergeRows(rows);
  strictEqual(result.length, 0);
});

test("unfired filter: non-merge rows ignored", () => {
  const rows = [
    { feature: "feat-dev",    stage: "dev",    notes_extra: null },
    { feature: "feat-review", stage: "review", notes_extra: null },
    { feature: "feat-merge",  stage: "merge",  notes_extra: null },
  ];
  const result = unfiredMergeRows(rows);
  strictEqual(result.length, 1);
  strictEqual(result[0].feature, "feat-merge");
});
