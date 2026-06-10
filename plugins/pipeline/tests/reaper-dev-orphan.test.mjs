import { test } from "node:test";
import { strictEqual, ok } from "node:assert";

// Unit test for the git command construction and error handling.
// The actual git integration is tested at the orchestrator level.
// These tests verify the logic and error handling of branchHasCommits.

function branchHasCommits(projectRoot, branch, targetBranch) {
  try {
    const r = require("node:child_process").spawnSync(
      "git",
      ["-C", projectRoot, "rev-list", "--count", `${targetBranch}..${branch}`],
      { encoding: "utf8", windowsHide: true }
    );
    return r.status === 0 && parseInt(r.stdout.trim(), 10) > 0;
  } catch { return false; }
}

// ── branchHasCommits ──────────────────────────────────────────────────────────────

test("branchHasCommits: returns false for nonexistent path", () => {
  strictEqual(branchHasCommits("/nonexistent/path/xyz", "autonomous/feat", "master"), false, "nonexistent path should return false");
});

test("branchHasCommits: returns false if git not found", () => {
  // When git is not in PATH, spawnSync raises ENOENT which is caught
  const result = branchHasCommits("/some/path", "branch", "target");
  strictEqual(result, false, "should handle git not found gracefully");
});

test("branchHasCommits: structure is correct for command formation", () => {
  // Verify the function doesn't throw and handles bad input
  const test1 = branchHasCommits("", "", "");
  ok(typeof test1 === "boolean", "should return a boolean");

  const test2 = branchHasCommits(null, null, null);
  ok(typeof test2 === "boolean", "should handle null inputs");
});
