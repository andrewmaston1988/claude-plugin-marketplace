// Tests for `--fast`'s skip rule (`scripts/test-lib/fast.mjs`): each row breaks
// one leg -- edited bytes, stale measurement, never slow -- and expects the file
// back in the run. Hashes are computed here, never by the module under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  mergeTimings,
  readTimings,
  recordTimings,
  slowFiles,
  timingKey,
} from "./test-lib/fast.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "fast-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

function write(repoRoot, rel, text) {
  const path = join(repoRoot, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function shaOf(repoRoot, rel) {
  return createHash("sha256").update(readFileSync(join(repoRoot, rel))).digest("hex");
}

function entry(repoRoot, rel, { ms = 45_000, at = NOW - DAY } = {}) {
  return { ms, sha256: shaOf(repoRoot, rel), at };
}

const skip = (timings, repoRoot) => slowFiles(timings, { repoRoot, now: () => NOW });

test("a measured-slow file whose bytes are unchanged is skipped and named", (t) => {
  const repo = makeRepo(t);
  const file = "plugins/swarm/tests/slow.test.mjs";
  write(repo, file, "slow\n");

  assert.deepEqual(skip({ [file]: entry(repo, file) }, repo), [{ file, ms: 45_000 }]);
});

test("an edited file runs again, and re-measuring it restores the skip", (t) => {
  const repo = makeRepo(t);
  const file = "plugins/swarm/tests/slow.test.mjs";
  write(repo, file, "slow\n");
  const timings = { [file]: entry(repo, file) };

  write(repo, file, "edited\n");
  assert.deepEqual(skip(timings, repo), [], "a changed file has not been measured as it is now");

  const remeasured = { [file]: entry(repo, file) };
  assert.deepEqual(skip(remeasured, repo).map((e) => e.file), [file]);
});

test("a measurement at or over seven days old runs the file again", (t) => {
  const repo = makeRepo(t);
  const file = "plugins/swarm/tests/slow.test.mjs";
  write(repo, file, "slow\n");

  const fresh = { [file]: entry(repo, file, { at: NOW - (7 * 24 * 60 * 60 * 1000) + 1 }) };
  const boundary = { [file]: entry(repo, file, { at: NOW - 7 * 24 * 60 * 60 * 1000 }) };
  const stale = { [file]: entry(repo, file, { at: NOW - 8 * DAY }) };

  assert.equal(skip(fresh, repo).length, 1);
  assert.deepEqual(skip(boundary, repo), []);
  assert.deepEqual(skip(stale, repo), []);
});

test("the slow bar is strict: 30.0 s runs, 30.001 s skips", (t) => {
  const repo = makeRepo(t);
  const file = "plugins/swarm/tests/slow.test.mjs";
  write(repo, file, "slow\n");

  const atBar = { [file]: entry(repo, file, { ms: 30_000 }) };
  const overBar = { [file]: entry(repo, file, { ms: 30_001 }) };

  assert.deepEqual(skip(atBar, repo), []);
  assert.deepEqual(skip(overBar, repo), [{ file, ms: 30_001 }]);
});

test("two suites' files with the same basename keep separate timings", (t) => {
  const repo = makeRepo(t);
  const resultsDir = join(repo, "test-results");
  const swarm = "plugins/swarm/tests/landed.test.mjs";
  const pipeline = "plugins/pipeline/tests/landed.test.mjs";
  write(repo, swarm, "swarm\n");
  write(repo, pipeline, "pipeline\n");

  recordTimings({
    resultsDir,
    repoRoot: repo,
    entries: [
      { file: swarm, ms: 45_000 },
      { file: pipeline, ms: 45_000 },
    ],
    now: () => NOW,
  });
  const timings = readTimings(resultsDir);
  assert.deepEqual(Object.keys(timings).sort(), [pipeline, swarm]);

  write(repo, pipeline, "pipeline edited\n");
  assert.deepEqual(skip(timings, repo).map((e) => e.file), [swarm]);
});

test("with no timings recorded nothing is skipped and nothing throws", (t) => {
  const repo = makeRepo(t);
  const timings = readTimings(join(repo, "test-results"));

  assert.deepEqual(timings, {});
  assert.deepEqual(skip(timings, repo), []);
});

test("a corrupt or malformed timings file reads as empty", (t) => {
  const repo = makeRepo(t);
  const resultsDir = join(repo, "test-results");
  mkdirSync(resultsDir, { recursive: true });
  const path = join(resultsDir, "timings.json");

  writeFileSync(path, "{not json", "utf8");
  assert.deepEqual(readTimings(resultsDir), {});

  writeFileSync(path, "[]", "utf8");
  assert.deepEqual(readTimings(resultsDir), {});

  writeFileSync(
    path,
    JSON.stringify({
      "plugins/x/tests/not-a-number.test.mjs": { ms: "slow", sha256: "h", at: NOW },
      "plugins/x/tests/nonsense.test.mjs": "nonsense",
      "plugins/x/tests/good.test.mjs": { ms: 45_000, sha256: "h", at: NOW },
    }),
    "utf8",
  );
  assert.deepEqual(Object.keys(readTimings(resultsDir)), ["plugins/x/tests/good.test.mjs"]);
});

test("mergeTimings replaces the same key and keeps the rest, without mutating", () => {
  const base = { "plugins/a/tests/x.test.mjs": { ms: 1_000, sha256: "a", at: 1 } };
  const merged = mergeTimings(base, {
    "plugins/b/tests/y.test.mjs": { ms: 2_000, sha256: "b", at: 2 },
    "plugins\\a\\tests\\x.test.mjs": { ms: 3_000, sha256: "c", at: 3 },
  });

  assert.deepEqual(merged, {
    "plugins/a/tests/x.test.mjs": { ms: 3_000, sha256: "c", at: 3 },
    "plugins/b/tests/y.test.mjs": { ms: 2_000, sha256: "b", at: 2 },
  });
  assert.deepEqual(base, { "plugins/a/tests/x.test.mjs": { ms: 1_000, sha256: "a", at: 1 } });
  assert.equal(timingKey("plugins\\a\\tests\\x.test.mjs"), "plugins/a/tests/x.test.mjs");
});

test("recordTimings hashes the file now, stamps the clock, merges, and leaves no temp file", (t) => {
  const repo = makeRepo(t);
  const resultsDir = join(repo, "test-results");
  const a = "plugins/x/tests/a.test.mjs";
  const b = "plugins/x/tests/b.test.mjs";
  write(repo, a, "a\n");
  write(repo, b, "b\n");

  const first = recordTimings({ resultsDir, repoRoot: repo, entries: [{ file: a, ms: 45_000 }], now: () => NOW });
  assert.equal(first.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(join(resultsDir, "timings.json"), "utf8")), {
    [a]: { ms: 45_000, sha256: shaOf(repo, a), at: NOW },
  });

  const second = recordTimings({ resultsDir, repoRoot: repo, entries: [{ file: b, ms: 31_000 }], now: () => NOW + 1_000 });
  assert.equal(second.ok, true);
  assert.deepEqual(Object.keys(readTimings(resultsDir)).sort(), [a, b].sort(), "the second run must not drop the first");
  assert.deepEqual(readdirSync(resultsDir).sort(), ["timings.json"]);
});

test("an unwritable cache reports failure instead of throwing", (t) => {
  const repo = makeRepo(t);
  const blocker = join(repo, "not-a-dir");
  writeFileSync(blocker, "x", "utf8");

  const result = recordTimings({
    resultsDir: blocker,
    repoRoot: repo,
    entries: [{ file: "plugins/x/tests/a.test.mjs", ms: 45_000 }],
    now: () => NOW,
  });
  assert.equal(result.ok, false);
  assert.ok(result.error);
});
