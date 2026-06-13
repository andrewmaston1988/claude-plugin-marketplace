import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

// Simple test for report-path detection in reaper.mjs
// Tests the glob matching logic for review reports

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");

// Helper function to test if a report file matches the expected pattern
function hasReportGlobMatch(reportsDir, feature, retryN) {
  if (!existsSync(reportsDir)) return false;

  const escapedFeature = feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^review-report-.*${escapedFeature}.*retry${retryN + 1}.*\\.md$`
  );

  try {
    const files = readdirSync(reportsDir);
    return files.some((file) => pattern.test(file));
  } catch {
    return false;
  }
}

test("hasReport detection with matching file", () => {
  const tempDir = join(os.tmpdir(), `reaper-test-${Date.now()}`);
  const reportsDir = join(tempDir, "reports");
  mkdirSync(reportsDir, { recursive: true });

  // Create a report matching the template's naming pattern
  const reportFile = "review-report-2026-06-10-my-feature-retry1-corr123.md";
  writeFileSync(join(reportsDir, reportFile), "# Review Report\n");

  const hasReport = hasReportGlobMatch(reportsDir, "my-feature", 0);
  assert.strictEqual(hasReport, true, "Should find report matching glob pattern");

  rmSync(tempDir, { recursive: true });
});

test("hasReport detection with no matching file", () => {
  const tempDir = join(os.tmpdir(), `reaper-test-${Date.now()}`);
  const reportsDir = join(tempDir, "reports");
  mkdirSync(reportsDir, { recursive: true });

  // Create an unrelated file
  writeFileSync(join(reportsDir, "other-file.md"), "# Other\n");

  const hasReport = hasReportGlobMatch(reportsDir, "my-feature", 0);
  assert.strictEqual(hasReport, false, "Should not find report for different feature");

  rmSync(tempDir, { recursive: true });
});

test("hasReport detection with missing directory", () => {
  const tempDir = join(os.tmpdir(), `reaper-test-${Date.now()}-missing`);
  const reportsDir = join(tempDir, "reports");

  const hasReport = hasReportGlobMatch(reportsDir, "my-feature", 0);
  assert.strictEqual(hasReport, false, "Should return false when directory doesn't exist");
});

test("hasReport detection with different retry number", () => {
  const tempDir = join(os.tmpdir(), `reaper-test-${Date.now()}`);
  const reportsDir = join(tempDir, "reports");
  mkdirSync(reportsDir, { recursive: true });

  // Create a report for retry 1 (retryN=0 produces retry1 filename)
  const reportFile = "review-report-2026-06-10-my-feature-retry1-corr123.md";
  writeFileSync(join(reportsDir, reportFile), "# Review Report\n");

  // Should not match when looking for retry 2 (retryN=1 looks for retry2 filename)
  const hasReport = hasReportGlobMatch(reportsDir, "my-feature", 1);
  assert.strictEqual(hasReport, false, "Should not match different retry number");

  rmSync(tempDir, { recursive: true });
});

test("hasReport detection with different feature name", () => {
  const tempDir = join(os.tmpdir(), `reaper-test-${Date.now()}`);
  const reportsDir = join(tempDir, "reports");
  mkdirSync(reportsDir, { recursive: true });

  // Create a report for feature-a
  const reportFile = "review-report-2026-06-10-feature-a-retry1-corr123.md";
  writeFileSync(join(reportsDir, reportFile), "# Review Report\n");

  // Should not match when looking for feature-b
  const hasReport = hasReportGlobMatch(reportsDir, "feature-b", 0);
  assert.strictEqual(hasReport, false, "Should not match different feature name");

  rmSync(tempDir, { recursive: true });
});

test("hasReport detection with exact date+corr format from template", () => {
  const tempDir = join(os.tmpdir(), `reaper-test-${Date.now()}`);
  const reportsDir = join(tempDir, "reports");
  mkdirSync(reportsDir, { recursive: true });

  // Create a report with the exact format from review-session.md template:
  // review-report-<date>-{{FEATURE}}-retry$((N+1))-${CORRELATION_ID}.md
  const reportFile = "review-report-2026-06-10-my-awesome-feature-retry3-reaper-review-report-path-fix-20260610T014600Z.md";
  writeFileSync(join(reportsDir, reportFile), "# Review Report\n");

  const hasReport = hasReportGlobMatch(reportsDir, "my-awesome-feature", 2);
  assert.strictEqual(
    hasReport,
    true,
    "Should find report with date and correlation ID suffixes"
  );

  rmSync(tempDir, { recursive: true });
});
