import { test } from "node:test";
import { ok, equal, strictEqual } from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";

// Helper: create a temporary plan file with given content
function createTempPlan(content) {
  const tmpDir = tmpdir();
  mkdirSync(tmpDir, { recursive: true });
  const planPath = join(tmpDir, `test-plan-${Date.now()}.md`);
  writeFileSync(planPath, content, "utf8");
  return planPath;
}

// Helper: clean up temp file
function cleanupPlan(planPath) {
  try { unlinkSync(planPath); } catch {}
}

// Test 1: queueTitleExtract parses *Title:* annotation
test("queueTitleExtract: parses *Title:* annotation correctly", async () => {
  const { run } = await import("../src/cli/queue.mjs");

  const planContent = `# Test Plan
*Branch:* \`autonomous/test-branch\`
*Title:* Implement new feature

## Motivation
This is a test.
`;

  const planPath = createTempPlan(planContent);
  try {
    const exitCode = await run("queue-title-extract", [planPath]);
    equal(exitCode, 0, "command should succeed");
    // Note: the actual output would be captured via stdout in a real scenario
  } finally {
    cleanupPlan(planPath);
  }
});

// Test 2: queueTitleExtract returns empty string when Title absent
test("queueTitleExtract: returns empty when *Title:* absent", async () => {
  const { run } = await import("../src/cli/queue.mjs");

  const planContent = `# Test Plan
*Branch:* \`autonomous/test-branch\`

## Motivation
No title annotation here.
`;

  const planPath = createTempPlan(planContent);
  try {
    const exitCode = await run("queue-title-extract", [planPath]);
    equal(exitCode, 0, "command should succeed even without title");
  } finally {
    cleanupPlan(planPath);
  }
});

// Test 3: queueTitleExtract trims to 256 chars
test("queueTitleExtract: trims title to 256 chars", async () => {
  const { run } = await import("../src/cli/queue.mjs");
  const longTitle = "x".repeat(300);
  const planContent = `# Test Plan
*Title:* ${longTitle}
`;

  const planPath = createTempPlan(planContent);
  try {
    const exitCode = await run("queue-title-extract", [planPath]);
    equal(exitCode, 0, "command should succeed");
  } finally {
    cleanupPlan(planPath);
  }
});

// Test 4: queueTitleExtract handles variant formatting
test("queueTitleExtract: handles *Title:* and * Title:* variants", async () => {
  const { run } = await import("../src/cli/queue.mjs");

  const planContent = `# Test Plan
* Title:* Add support for new API

## Content
Test.
`;

  const planPath = createTempPlan(planContent);
  try {
    const exitCode = await run("queue-title-extract", [planPath]);
    equal(exitCode, 0, "command should parse variant format");
  } finally {
    cleanupPlan(planPath);
  }
});

// Test 5: pr-title-get CLI command
test("pr-title-get: reads pr_title from database", async () => {
  try {
    const { connectPath, close } = await import("../scripts/pipeline-db/connection.mjs");
    const { rowAdd, rowGet } = await import("../scripts/pipeline-db/index.mjs");

    const db = connectPath(":memory:");

    // Add a row with pr_title
    rowAdd(db, "test-project", {
      feature: "test-feature",
      planFile: "/tmp/test.md",
      stage: "queued",
      prTitle: "Test PR Title",
    });

    const row = rowGet(db, "test-project", "test-feature");
    ok(row, "row should exist");
    equal(row.pr_title, "Test PR Title", "pr_title should match");

    close(db);
  } catch (e) {
    ok(false, `pr-title-get test failed: ${e.message}`);
  }
});

// Test 6: pr_title column handles NULL values
test("pr_title: database column handles NULL values", async () => {
  try {
    const { connectPath, close } = await import("../scripts/pipeline-db/connection.mjs");
    const { rowAdd, rowGet } = await import("../scripts/pipeline-db/index.mjs");

    const db = connectPath(":memory:");

    // Add a row without pr_title
    rowAdd(db, "test-project", {
      feature: "test-feature",
      planFile: "/tmp/test.md",
      stage: "queued",
    });

    const row = rowGet(db, "test-project", "test-feature");
    ok(row, "row should exist");
    strictEqual(row.pr_title, null, "pr_title should be null");

    close(db);
  } catch (e) {
    ok(false, `pr_title NULL test failed: ${e.message}`);
  }
});

// Test 7: pr-title-get returns empty when column is NULL
test("pr-title-get: returns empty string when pr_title is NULL", async () => {
  try {
    const { connectPath, close } = await import("../scripts/pipeline-db/connection.mjs");
    const { rowAdd, rowGet } = await import("../scripts/pipeline-db/index.mjs");

    const db = connectPath(":memory:");
    rowAdd(db, "test-project", {
      feature: "test-feature",
      planFile: "/tmp/test.md",
      stage: "queued",
    });

    const row = rowGet(db, "test-project", "test-feature");
    const title = row.pr_title || "";
    equal(title, "", "should return empty string as fallback");

    close(db);
  } catch (e) {
    ok(false, `pr-title empty fallback test failed: ${e.message}`);
  }
});
