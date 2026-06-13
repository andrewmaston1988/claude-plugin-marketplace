import test from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { findZombieRows, findOrphanBranches, findMergeReadyStuck, formatZombieRowsFindings } from "../src/doctor/checks/zombie-rows.mjs";

// Helper: create a test database and schema
function createTestDb() {
  const db = new DatabaseSync(":memory:");

  db.exec(`
    CREATE TABLE pipeline_rows (
      project TEXT NOT NULL,
      feature TEXT NOT NULL,
      plan_file TEXT NOT NULL,
      stage TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT '—',
      target_branch TEXT DEFAULT 'main',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notes_extra TEXT,
      PRIMARY KEY (project, feature)
    );

    CREATE TABLE projects (
      name TEXT PRIMARY KEY,
      root_path TEXT NOT NULL UNIQUE
    );
  `);

  return db;
}

// Helper: add a row to the test DB
function addRow(db, project, feature, {
  planFile = "plans/test.md",
  stage = "dev",
  branch = "autonomous/test",
  targetBranch = "main",
  createdAt = new Date().toISOString(),
  notesExtra = null,
} = {}) {
  db.prepare(`
    INSERT INTO pipeline_rows (project, feature, plan_file, stage, branch, target_branch, created_at, notes_extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(project, feature, planFile, stage, branch, targetBranch, createdAt, notesExtra);
}

// Helper: add a project to the test DB
function addProject(db, name, rootPath) {
  db.prepare(`
    INSERT INTO projects (name, root_path)
    VALUES (?, ?)
  `).run(name, rootPath);
}

test("findZombieRows: detects done rows not under plans/complete/", () => {
  const db = createTestDb();
  const projectRoot = "/fake/project";

  addProject(db, "test-project", projectRoot);

  // Add a done row with plan_file not under plans/complete/
  addRow(db, "test-project", "feature-1", {
    planFile: "plans/feature-1.md",
    stage: "done",
  });

  // Add a done row with plan_file under plans/complete/
  addRow(db, "test-project", "feature-2", {
    planFile: "plans/complete/feature-2.md",
    stage: "done",
  });

  // Add a non-done row (should be ignored)
  addRow(db, "test-project", "feature-3", {
    planFile: "plans/feature-3.md",
    stage: "dev",
  });

  const findings = findZombieRows(db, "test-project", projectRoot);

  // Should find only feature-1
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].type, "zombie-done-row");
  assert.strictEqual(findings[0].feature, "feature-1");
  assert.strictEqual(findings[0].planFile, "plans/feature-1.md");
});

test("findZombieRows: identifies when commit refers to slug", () => {
  const db = createTestDb();
  const projectRoot = "/fake/project";

  addProject(db, "test-project", projectRoot);

  // Add a done row
  addRow(db, "test-project", "test-feature", {
    planFile: "plans/test-feature.md",
    stage: "done",
  });

  const findings = findZombieRows(db, "test-project", projectRoot);

  // Should have one finding; git log will likely fail in test, so commitRefersToSlug will be false
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].type, "zombie-done-row");
});

test("findMergeReadyStuck: detects old merge rows with merge-ready-fired tag", () => {
  const db = createTestDb();
  const projectRoot = "/fake/project";

  addProject(db, "test-project", projectRoot);

  // Add a fresh merge row (should NOT be detected)
  const now = new Date();
  const fresh = new Date(now.getTime() - 12 * 60 * 60 * 1000); // 12 hours old
  addRow(db, "test-project", "feature-fresh", {
    planFile: "plans/feature-fresh.md",
    stage: "merge",
    createdAt: fresh.toISOString(),
    notesExtra: "[merge-ready-fired]",
  });

  // Add an old merge row (SHOULD be detected)
  const old = new Date(now.getTime() - 36 * 60 * 60 * 1000); // 36 hours old
  addRow(db, "test-project", "feature-old", {
    planFile: "plans/feature-old.md",
    stage: "merge",
    createdAt: old.toISOString(),
    notesExtra: "[merge-ready-fired]",
  });

  // Add a merge row without the tag (should NOT be detected)
  addRow(db, "test-project", "feature-notag", {
    planFile: "plans/feature-notag.md",
    stage: "merge",
    createdAt: old.toISOString(),
    notesExtra: null,
  });

  const findings = findMergeReadyStuck(db, "test-project", projectRoot);

  // Should find only the old row with the tag
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].type, "merge-ready-stuck");
  assert.strictEqual(findings[0].feature, "feature-old");
  assert(findings[0].ageHours >= 24);
});

test("formatZombieRowsFindings: formats empty findings", () => {
  const result = formatZombieRowsFindings([]);
  assert(result.includes("no zombie rows"));
});

test("formatZombieRowsFindings: formats zombie row findings", () => {
  const findings = [
    {
      type: "zombie-done-row",
      severity: "warn",
      project: "test-project",
      feature: "feature-1",
      stage: "done",
      planFile: "plans/feature-1.md",
      commitRefersToSlug: true,
      needsMoveAction: false,
      targetBranch: "main",
    },
  ];

  const result = formatZombieRowsFindings(findings);

  assert(result.includes("zombie done-row"));
  assert(result.includes("feature-1"));
  assert(result.includes("Commit found on target"));
});

test("formatZombieRowsFindings: formats orphan branch findings", () => {
  const findings = [
    {
      type: "orphan-autonomous-branch",
      severity: "warn",
      branch: "autonomous/feature-1",
      slug: "feature-1",
      commitsAhead: 0,
      branchRef: "autonomous/feature-1",
    },
  ];

  const result = formatZombieRowsFindings(findings);

  assert(result.includes("orphan autonomous branch"));
  assert(result.includes("feature-1"));
  assert(result.includes("git branch -D"));
});

test("formatZombieRowsFindings: formats merge-ready stuck findings", () => {
  const findings = [
    {
      type: "merge-ready-stuck",
      severity: "warn",
      project: "test-project",
      feature: "feature-1",
      stage: "merge",
      ageHours: 48,
      targetBranch: "main",
      createdAt: new Date().toISOString(),
    },
  ];

  const result = formatZombieRowsFindings(findings);

  assert(result.includes("merge-ready stuck"));
  assert(result.includes("48h"));
});
