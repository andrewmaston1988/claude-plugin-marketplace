// Tests for the orphan check: a test file the repository carries but no suite
// runs is an accident unless `notRun` names it, so the check walks the whole
// repository rather than the directories the suites already name.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SUITES, notRun } from "./test-suites.mjs";
import { orphanTests } from "./test-lib/orphans.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function write(cwd, rel) {
  const path = join(cwd, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "export const t = 1;\n", "utf8");
}

/** One covered test, one stray beside it, one stray elsewhere, and test files
 *  in the three trees nobody walks. */
function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "orphans-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  for (const rel of [
    "plugins/x/tests/covered.test.mjs",
    "plugins/x/tests/stray.test.mjs",
    "other/y.test.mjs",
    "plugins/x/tests/fixtures/data.test.mjs",
    "node_modules/dep/z.test.mjs",
    "sessions/old/s.test.mjs",
  ]) {
    write(dir, rel);
  }
  return dir;
}

const SUITE = { name: "x", runs: [{ cwd: ".", globs: ["plugins/x/tests/covered.test.mjs"], timeoutMs: 600000 }] };

test("a test file no suite expands to is an orphan, wherever it sits", (t) => {
  const repo = makeRepo(t);
  assert.deepEqual(orphanTests([SUITE], { repoRoot: repo }), ["other/y.test.mjs", "plugins/x/tests/stray.test.mjs"]);
});

test("a test file a suite expands to is not an orphan", (t) => {
  const repo = makeRepo(t);
  assert.deepEqual(orphanTests([SUITE], { repoRoot: repo }).filter((file) => file.endsWith("covered.test.mjs")), []);
});

test("a notRun entry drops out", (t) => {
  const repo = makeRepo(t);
  const orphans = orphanTests([SUITE], {
    repoRoot: repo,
    notRun: [{ path: "other/y.test.mjs", reason: "prototype, run by hand" }],
  });
  assert.deepEqual(orphans, ["plugins/x/tests/stray.test.mjs"]);
});

test("fixtures, node_modules and sessions are not walked", (t) => {
  const repo = makeRepo(t);
  const orphans = orphanTests([SUITE], { repoRoot: repo });
  for (const tree of ["fixtures/", "node_modules/", "sessions/"]) {
    assert.deepEqual(orphans.filter((file) => file.includes(`/${tree}`)), [], `${tree} was walked`);
  }
});

test("the repository this test runs in has no orphans", () => {
  assert.deepEqual(orphanTests(SUITES, { repoRoot: ROOT, notRun }), []);
});
