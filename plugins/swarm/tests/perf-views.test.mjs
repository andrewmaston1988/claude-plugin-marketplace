import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { aggregate, dedupe } from "../src/scores.mjs";
import { OUTCOMES } from "../src/aspects.mjs";
import { coverage, reliability, leaders } from "../src/serve/perf-views.mjs";

// Minimal valid row — mirrors scores.test.mjs's baseline shape so aggregate()
// and dedupe() see exactly what the real store would hand them.
function row(over = {}) {
  return {
    resultsDir: "C:/runs/x-1",
    leaf: "leaf",
    model: "m",
    domain: "godot",
    grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8 },
    outcome: "completed",
    note: "",
    assessedBy: { session: "s" },
    ...over,
  };
}
const graded = (over) => row({ note: "x", ...over });

// ── coverage ────────────────────────────────────────────────────────────────

test("coverage: one cell per model×aspect; n=0 for a model never touched on that aspect", () => {
  const rows = [
    graded({ leaf: "a1", model: "m-a", grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8, code: 8 } }),
    graded({ leaf: "b1", model: "m-b", grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8 } }), // never touches `code`
  ];
  const report = aggregate(rows);
  const { aspects, models, cells } = coverage(report);
  deepEqual(models, ["m-a", "m-b"]);
  ok(aspects.includes("code") && aspects.includes("adherence"));
  const mbCode = cells.find((c) => c.model === "m-b" && c.aspect === "code");
  ok(mbCode, "m-b×code cell must exist even though m-b was never graded on it");
  equal(mbCode.n, 0);
  equal(mbCode.provisional, true, "n=0 is thin evidence too, never treated as solid");
  const maAdherence = cells.find((c) => c.model === "m-a" && c.aspect === "adherence");
  equal(maAdherence.n, 1);
  equal(maAdherence.provisional, true, "n=1 < 5 is provisional");
});

test("coverage: n >= 5 is not provisional", () => {
  const rows = Array.from({ length: 5 }, (_, i) => graded({ leaf: `l${i}`, model: "m-thick" }));
  const { cells } = coverage(aggregate(rows));
  const c = cells.find((x) => x.model === "m-thick" && x.aspect === "adherence");
  equal(c.n, 5);
  equal(c.provisional, false);
});

// ── reliability ─────────────────────────────────────────────────────────────

test("reliability: counts each deduped leaf once, even one graded on two aspects", () => {
  const rows = [
    graded({ leaf: "l1", model: "m-a", grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8, code: 8, impl: 7 } }),
    row({ leaf: "l2", model: "m-a", outcome: "wrong", note: "off-spec", grades: { adherence: 3, handoff: 3, truthfulness: 3, depth: 3 } }),
  ];
  const live = dedupe(rows);
  const result = reliability(live);
  const ma = result.find((r) => r.model === "m-a");
  equal(ma.total, 2, "one leaf graded on two aspects (code, impl) still counts once");
  equal(ma.byOutcome.completed, 1);
  equal(ma.byOutcome.wrong, 1);
  deepEqual(Object.keys(ma.byOutcome), OUTCOMES, "all six outcome buckets present, even at zero");
});

test("reliability: a re-graded leaf (superseded row) is not double counted", () => {
  const first = row({ leaf: "l1", model: "m-a", grades: { adherence: 3, handoff: 3, truthfulness: 3, depth: 3 }, note: "poor" });
  const second = graded({ leaf: "l1", model: "m-a" });
  const live = dedupe([first, second]);
  const result = reliability(live);
  equal(result.find((r) => r.model === "m-a").total, 1);
});

test("reliability: sorted by total descending", () => {
  const rows = [
    ...Array.from({ length: 2 }, (_, i) => graded({ leaf: `a${i}`, model: "m-small" })),
    ...Array.from({ length: 5 }, (_, i) => graded({ leaf: `b${i}`, model: "m-big" })),
  ];
  const result = reliability(dedupe(rows));
  deepEqual(result.map((r) => r.model), ["m-big", "m-small"]);
});

// ── leaders ─────────────────────────────────────────────────────────────────

test("leaders: ordered by weighted score, capped at k, provisional flagged, outcomes-only model excluded", () => {
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => graded({ leaf: `s${i}`, model: "m-strong", grades: { adherence: 9, handoff: 9, truthfulness: 9, depth: 9 } })),
    ...Array.from({ length: 6 }, (_, i) => graded({ leaf: `w${i}`, model: "m-weak", grades: { adherence: 6, handoff: 6, truthfulness: 6, depth: 6 } })),
    graded({ leaf: "t0", model: "m-thin", grades: { adherence: 3, handoff: 3, truthfulness: 3, depth: 3 } }),
    row({ leaf: "d0", model: "m-dead", outcome: "session-died", note: "died", grades: undefined }),
  ];
  const report = aggregate(rows, { aspect: "adherence" });
  const result = leaders(report, 3);
  equal(result.length, 1);
  const { aspect, top } = result[0];
  equal(aspect, "adherence");
  equal(top.length, 3, "capped at k even though four models have cells");
  deepEqual(top.map((t) => t.model), ["m-strong", "m-weak", "m-thin"], "m-dead has no grade and is excluded");
  ok(top[0].weighted > top[1].weighted, "ordered by weighted score");
  equal(top.find((t) => t.model === "m-thin").provisional, true, "n=1 is provisional");
  equal(top.find((t) => t.model === "m-strong").provisional, false, "n=6 is not provisional");
});

test("leaders: default k=3", () => {
  const rows = Array.from({ length: 4 }, (_, i) => graded({ leaf: `l${i}`, model: `m-${i}` }));
  const report = aggregate(rows, { aspect: "adherence" });
  equal(leaders(report).find((r) => r.aspect === "adherence").top.length, 3);
});
