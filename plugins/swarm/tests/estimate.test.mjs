import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { median, loadCorpus, estimateRun, projectRun, formatEstimate } from "../src/estimate.mjs";

// Estimates are consent infrastructure: worst-case leaf counts × historical
// per-model medians, labelled ~, never a guess on cold start.

const tok = (n) => ({ input: n, output: 0, cacheCreation: 0, cacheRead: 999999 }); // cacheRead must not count

function seedRun(root, cwdDir, runDir, tasks) {
  const dir = join(root, cwdDir, runDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ tasks }));
  return dir;
}

// ── median ────────────────────────────────────────────────────────────────────

test("median: odd, even, single", () => {
  equal(median([3, 1, 2]), 2);
  equal(median([1, 2, 3, 4]), 2.5);
  equal(median([7]), 7);
});

// ── loadCorpus ────────────────────────────────────────────────────────────────

test("loadCorpus walks runsRoot/*/*/summary.json and collects per-model samples", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-est-"));
  try {
    seedRun(root, "proj-a", "plan-1", [
      { id: "a", state: "ok", model: "haiku", tokens: tok(100) },
      { id: "b", state: "ok", model: "haiku", tokens: tok(300), costUsd: 0.5 },
      { id: "c", state: "ok", model: "glm-5.2:cloud", tokens: tok(50) },
    ]);
    seedRun(root, "proj-b", "plan-2", [
      { id: "d", state: "ok", model: "haiku", tokens: tok(200) },
    ]);
    const corpus = loadCorpus(root);
    deepEqual(corpus.tokens.get("haiku").sort((x, y) => x - y), [100, 200, 300]);
    deepEqual(corpus.tokens.get("glm-5.2:cloud"), [50]);
    deepEqual(corpus.costUsd.get("haiku"), [0.5]);
    equal(corpus.costUsd.get("glm-5.2:cloud"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadCorpus skips non-ok rows, compute rows, rows without model or tokens, corrupt files, and a missing root", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-est-"));
  try {
    seedRun(root, "p", "r-1", [
      { id: "bad", state: "failed", model: "haiku", tokens: tok(100) },
      { id: "comp", state: "ok", model: "compute", tokens: tok(100) },
      { id: "old", state: "ok", tokens: tok(100) },            // pre-D1 summary row: no model
      { id: "none", state: "ok", model: "haiku" },              // no tokens
      { id: "good", state: "ok", model: "haiku", tokens: tok(42) },
    ]);
    const corruptDir = join(root, "p", "r-2");
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, "summary.json"), "{not json");
    const corpus = loadCorpus(root);
    deepEqual(corpus.tokens.get("haiku"), [42]);
    const empty = loadCorpus(join(root, "does-not-exist"));
    equal(empty.tokens.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── estimateRun ───────────────────────────────────────────────────────────────

const corpusOf = (tokens = {}, costUsd = {}) => ({
  tokens: new Map(Object.entries(tokens)),
  costUsd: new Map(Object.entries(costUsd)),
});

test("estimateRun: plain leaves ×1, forEach ×maxItems, compute ×0, digest +1; median × count per model", () => {
  const tasks = [
    { id: "scan", model: "haiku" },
    { id: "dedupe", model: "compute", compute: "length(deps['scan'])" },
    { id: "fix", model: "haiku", forEach: { from: "dedupe", path: "", maxItems: 3 } },
  ];
  const est = estimateRun(tasks, { model: "haiku" }, corpusOf({ haiku: [100, 200, 300] }));
  // 1 (scan) + 3 (fix clones) + 1 (digest) = 5 leaves × median 200
  equal(est.tokens, 1000);
  deepEqual(est.counted, [{ model: "haiku", leaves: 5, perLeaf: 200 }]);
  deepEqual(est.unknown, []);
  equal(est.usd, undefined);
});

test("estimateRun: models without history land in unknown; tokens still estimated for the rest", () => {
  const tasks = [
    { id: "a", model: "haiku" },
    { id: "b", model: "glm-5.2:cloud", forEach: { from: "a", path: "", maxItems: 12 } },
  ];
  const est = estimateRun(tasks, undefined, corpusOf({ haiku: [500] }));
  equal(est.tokens, 500);
  deepEqual(est.unknown, [{ model: "glm-5.2:cloud", leaves: 12 }]);
});

test("estimateRun: usd only when every counted model has cost samples and nothing is unknown", () => {
  const tasks = [{ id: "a", model: "haiku" }, { id: "b", model: "sonnet" }];
  const full = estimateRun(tasks, undefined,
    corpusOf({ haiku: [100], sonnet: [200] }, { haiku: [0.1, 0.3], sonnet: [1] }));
  equal(full.usd, 0.2 + 1);
  const partialCost = estimateRun(tasks, undefined,
    corpusOf({ haiku: [100], sonnet: [200] }, { haiku: [0.1] }));
  equal(partialCost.usd, undefined);
  const withUnknown = estimateRun([...tasks, { id: "c", model: "kimi:cloud" }], undefined,
    corpusOf({ haiku: [100], sonnet: [200] }, { haiku: [0.1], sonnet: [1] }));
  equal(withUnknown.usd, undefined);
});

test("estimateRun: cold start (no counted model has history) returns null", () => {
  equal(estimateRun([{ id: "a", model: "haiku" }], undefined, corpusOf()), null);
});

// ── projectRun ────────────────────────────────────────────────────────────────

test("projectRun: null under 2 completed; linear projection over the rest", () => {
  equal(projectRun({ spent: 500, completed: 1, remaining: 9 }), null);
  equal(projectRun({ spent: 600, completed: 2, remaining: 8 }), 600 + 300 * 8);
  equal(projectRun({ spent: 600, completed: 3, remaining: 0 }), 600);
});

// ── formatEstimate ────────────────────────────────────────────────────────────

test("formatEstimate: tokens only, tokens+usd, partial with unknown list, and the cold-start line", () => {
  equal(
    formatEstimate({ tokens: 1_250_000, counted: [{ model: "haiku", leaves: 5, perLeaf: 250000 }], unknown: [] }),
    "estimated ~1.25M tokens",
  );
  equal(
    formatEstimate({ tokens: 1_250_000, usd: 4.2, counted: [{ model: "haiku", leaves: 5, perLeaf: 250000 }], unknown: [] }),
    "estimated ~1.25M tokens · ~$4.20",
  );
  equal(
    formatEstimate({ tokens: 800_000, counted: [{ model: "haiku", leaves: 4, perLeaf: 200000 }], unknown: [{ model: "glm-5.2:cloud", leaves: 12 }] }),
    "estimated ~800k tokens (no history for: glm-5.2:cloud — 12 leaves uncounted)",
  );
  equal(formatEstimate(null), "estimate: none (no run history yet)");
});
