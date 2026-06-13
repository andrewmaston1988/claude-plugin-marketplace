import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPrereqs, queueDepsExtract } from "../src/cli/queue.mjs";

test("classifyPrereqs: soft default, ! = strict, cross-project stays soft", () => {
  const r = classifyPrereqs(["a", "!b", "esg:c"]);
  deepEqual(r.soft, ["a", "esg:c"]);
  equal(r.strict, "b");
  equal(r.error, null);
});

test("classifyPrereqs: soft is the default (no auto-strict)", () => {
  const r = classifyPrereqs(["a", "b"]);
  deepEqual(r.soft, ["a", "b"]);
  equal(r.strict, null);
  equal(r.error, null);
});

test("classifyPrereqs: more than one strict is an error", () => {
  equal(classifyPrereqs(["!a", "!b"]).error !== null, true);
});

test("classifyPrereqs: a strict cross-project token is an error", () => {
  equal(classifyPrereqs(["!esg:c"]).error !== null, true);
});

test("queueDepsExtract: preserves a leading ! on a prerequisite token", () => {
  const dir = mkdtempSync(join(tmpdir(), "prereq-unify-"));
  const p = join(dir, "plan.md");
  writeFileSync(p, "# T\n*Prerequisites:* `!autonomous/auth-refactor`\n");
  try {
    equal(queueDepsExtract(p), "!auth-refactor");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
