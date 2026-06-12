import { test } from "node:test";
import { equal } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueTypeExtract, queueModelExtract, queueDepsExtract } from "../src/cli/queue.mjs";

function withPlan(body, fn) {
  const dir = mkdtempSync(join(tmpdir(), "queue-annot-"));
  const p = join(dir, "plan.md");
  writeFileSync(p, body, "utf8");
  try { return fn(p); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("queueTypeExtract: reads a valid *Type:* annotation (both punctuation forms)", () => {
  withPlan("# T\n*Type:* research\n", (p) => equal(queueTypeExtract(p), "research"));
  withPlan("# T\n*Type: dev*\n", (p) => equal(queueTypeExtract(p), "dev"));
});

test("queueTypeExtract: missing or invalid → empty string", () => {
  withPlan("# T\n\nno type here\n", (p) => equal(queueTypeExtract(p), ""));
  withPlan("# T\n*Type:* bogus\n", (p) => equal(queueTypeExtract(p), ""));
});

test("queueModelExtract: reads the per-kind model annotation", () => {
  withPlan("# T\n*Dev-Model:* claude-sonnet-4-6\n", (p) =>
    equal(queueModelExtract(p, "dev"), "claude-sonnet-4-6"));
  withPlan("# T\n*Review-Model:* claude-haiku-4-5\n", (p) =>
    equal(queueModelExtract(p, "review"), "claude-haiku-4-5"));
  withPlan("# T\n(no model)\n", (p) => equal(queueModelExtract(p, "dev"), ""));
});

test("queueDepsExtract: captures a cross-project project:feature token", () => {
  withPlan("# T\n*Prerequisites:* `esg-ng-core-linux:SYM-8617-esg-research`\n", (p) =>
    equal(queueDepsExtract(p), "esg-ng-core-linux:SYM-8617-esg-research"));
});

test("queueDepsExtract: mixes same-project and cross-project tokens", () => {
  withPlan("# T\n*Prerequisites:* `autonomous/theme-refactor`, `esg:feat-x`\n", (p) =>
    equal(queueDepsExtract(p), "esg:feat-x,theme-refactor"));
});

test("queueDepsExtract: autonomous-only still strips to bare slug", () => {
  withPlan("# T\n*Prerequisites:* `autonomous/theme-refactor`\n", (p) =>
    equal(queueDepsExtract(p), "theme-refactor"));
});
