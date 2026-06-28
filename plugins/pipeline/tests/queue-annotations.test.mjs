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

test("queueDepsExtract: annotation present but value unparseable → null", () => {
  withPlan("# T\n*Prerequisites:* see the other plan\n", (p) =>
    equal(queueDepsExtract(p), null));
});

test("queueDepsExtract: no annotation at all → empty string (not null)", () => {
  withPlan("# T\n\nno prerequisites line at all\n", (p) =>
    equal(queueDepsExtract(p), ""));
});

test("queueDepsExtract: dotted-version slug (e.g. scout's 0.9-… stems) parses verbatim", () => {
  // Regression for queue-plan: prerequisite slug parser mangles dotted-version slugs.
  // The regex character class used to exclude `.`, truncating `0.9-foo` to `0`.
  withPlan("# T\n*Prerequisites:* `autonomous/0.9-foo`\n", (p) =>
    equal(queueDepsExtract(p), "0.9-foo"));
  withPlan("# T\n*Prerequisites:* `autonomous/0.9-gdscript-language-pack-loader`\n", (p) =>
    equal(queueDepsExtract(p), "0.9-gdscript-language-pack-loader"));
});

test("queueDepsExtract: dotted-version slug without backticks parses verbatim", () => {
  // The "fallback" pattern (no backticks) had the same bug.
  withPlan("# T\n*Prerequisites:* autonomous/0.9-foo\n", (p) =>
    equal(queueDepsExtract(p), "0.9-foo"));
});

test("queueDepsExtract: strict (!) dotted-version slug preserves the marker", () => {
  withPlan("# T\n*Prerequisites:* `!autonomous/0.9-foo`\n", (p) =>
    equal(queueDepsExtract(p), "!0.9-foo"));
});
