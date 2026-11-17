// CLI rows for the 500-line bar: how a crossing is DERIVED from real git trees.
// `check-file-size.test.mjs` owns the pure predicate rule; these drive the
// staged and `--against` adapters that feed it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { commitAll, git, makeRepo, runChecker, writeLines } from "./check-file-size-fixture.mjs";

test("staged growth across the bar fails with exit 1", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "a.mjs", 499);
  commitAll(repo, "seed");
  writeLines(repo, "a.mjs", 874);
  git(repo, "add", "-A");

  const r = runChecker(repo);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /a\.mjs/);
  assert.match(r.stderr, /499 -> 874/);
});

test("--against catches a crossing made in one commit", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "a.mjs", 499);
  commitAll(repo, "seed");
  const base = git(repo, "rev-parse", "HEAD").trim();
  writeLines(repo, "a.mjs", 874);
  commitAll(repo, "grow");

  const r = runChecker(repo, "--against", base);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /499 -> 874/);
});

test("--against catches a crossing spread over several commits", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "a.mjs", 499);
  commitAll(repo, "seed");
  const base = git(repo, "rev-parse", "HEAD").trim();
  writeLines(repo, "a.mjs", 700);
  commitAll(repo, "mid");
  writeLines(repo, "a.mjs", 874);
  commitAll(repo, "grow");

  const r = runChecker(repo, "--against", base);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /499 -> 874/);
});

test("a rename that grows across the bar fails under its new path", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "old.mjs", 490);
  commitAll(repo, "seed");
  git(repo, "mv", "old.mjs", "moved.mjs");
  writeLines(repo, "moved.mjs", 874);
  git(repo, "add", "-A");

  const r = runChecker(repo);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /moved\.mjs/);
  assert.doesNotMatch(r.stderr, /^ {2}old\.mjs/m, r.stderr);
  assert.match(r.stderr, /490 -> 874/);
});

test("--against sees endpoints only, so an intermediate peak passes", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "a.mjs", 499);
  commitAll(repo, "seed");
  const base = git(repo, "rev-parse", "HEAD").trim();
  writeLines(repo, "a.mjs", 700);
  commitAll(repo, "peak");
  writeLines(repo, "a.mjs", 480);
  commitAll(repo, "settle");

  const r = runChecker(repo, "--against", base);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
