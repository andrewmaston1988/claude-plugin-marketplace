import { test } from "node:test";
import { equal } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueBranchExtract } from "../src/cli/queue.mjs";

function withPlan(body, fn) {
  const dir = mkdtempSync(join(tmpdir(), "queue-branch-"));
  const p = join(dir, "plan.md");
  writeFileSync(p, body, "utf8");
  try { return fn(p); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("extracts a non-autonomous branch from the *Branch:* annotation", () => {
  withPlan("# Title\n*Branch: `anm/PROJ-101_tooltips`*\n", (p) =>
    equal(queueBranchExtract(p), "anm/PROJ-101_tooltips"));
});

test("still extracts autonomous/ and interactive/ branches", () => {
  withPlan("# T\n*Branch:* `autonomous/dark-mode`\n", (p) =>
    equal(queueBranchExtract(p), "autonomous/dark-mode"));
  withPlan("# T\n*Branch: `interactive/x`*\n", (p) =>
    equal(queueBranchExtract(p), "interactive/x"));
});

test("returns empty string when no annotation present", () => {
  withPlan("# T\n\nNo branch line.\n", (p) => equal(queueBranchExtract(p), ""));
});
