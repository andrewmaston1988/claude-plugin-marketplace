import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { aggregate, dedupe, overall } from "../src/scores.mjs";
import { OUTCOMES } from "../src/aspects.mjs";
import { coverage, reliability, leaders, costView, rankCells } from "../src/serve/perf-views.mjs";
import { DEFAULT_COST_BANDS, costRowsFor as providerCostRows } from "../src/cost.mjs";

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

test("leaders: sorts by weighted score itself, independent of the report's own cell order", () => {
  const report = {
    aspects: [
      { aspect: "a", cells: [
        { model: "m-low", weighted: 2, n: 5, provisional: false },
        { model: "m-high", weighted: 9, n: 5, provisional: false },
        { model: "m-mid", weighted: 5, n: 5, provisional: false },
      ] },
    ],
  };
  const { top } = leaders(report, 3).find((r) => r.aspect === "a");
  deepEqual(top.map((t) => t.model), ["m-high", "m-mid", "m-low"], "leaders must not trust the report's own cell order");
});

test("coverage: composite key does not collide when a model or aspect name contains a space", () => {
  const report = {
    aspects: [
      { aspect: "a", cells: [{ model: "b c", n: 3, provisional: false }] },
      { aspect: "a b", cells: [{ model: "c", n: 9, provisional: false }] },
    ],
  };
  const { cells } = coverage(report);
  equal(cells.find((c) => c.aspect === "a" && c.model === "b c").n, 3);
  equal(cells.find((c) => c.aspect === "a b" && c.model === "c").n, 9);
});

test("performance views collapse same-named leaves while cost domains stay provider-local", () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => graded({ leaf: `ollama-${i}`, provider: "ollama", model: "same-model" })),
    ...Array.from({ length: 5 }, (_, i) => graded({ leaf: `codex-${i}`, provider: "codex", model: "same-model" })),
  ];
  const report = aggregate(rows, { aspect: "adherence", combineProviders: true });
  const view = coverage(report);
  equal(view.identities.length, 1);
  equal(view.cells.filter((c) => c.model === "same-model").length, 1);
  deepEqual(view.identities[0].providers, ["codex", "ollama"]);

  const rel = reliability(dedupe(rows));
  equal(rel.length, 1);
  deepEqual(rel[0].providers, ["codex", "ollama"]);

  const cost = costView(rows, [
    costRow("same-model", 1, { provider: "ollama", unit: "meter-points", costDomain: "ollama:meter-points:unpriced" }),
    costRow("same-model", null, { provider: "codex", unit: "usd", classification: "api-equivalent estimate", costDomain: "codex:usd:api-equivalent estimate" }),
  ]);
  equal(cost.points.length, 2);
  equal(cost.points.find((p) => p.provider === "ollama").multiplier, 1);
  equal(cost.points.find((p) => p.provider === "codex").multiplier, null);
  equal(cost.points.find((p) => p.provider === "codex").dominatedBy, null,
    "an incompatible USD estimate cannot dominate or be dominated by meter points");
  equal(cost.spread.find((p) => p.provider === "codex").classification, "api-equivalent estimate");
  deepEqual(cost.sections.map((section) => section.provider), ["codex", "ollama"]);
  equal(cost.best, null, "mixed providers do not produce a misleading global cost pick");
  equal(cost.sections.find((section) => section.provider === "ollama").best.provider, "ollama");
});

test("cost view keeps provider history even when a model has no current quality row", () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => graded({ leaf: `same-${i}`, provider: "ollama", model: "same-model" })),
  ];
  const cost = costView(rows, [
    costRow("same-model", 1, { provider: "ollama", costDomain: "ollama:meter-points:unpriced" }),
    costRow("same-model", 4, { provider: "codex", costDomain: "codex:relative:rate-card" }),
    costRow("old-model", 2, { provider: "codex", costDomain: "codex:relative:rate-card" }),
  ]);
  equal(cost.points.filter((point) => point.model === "same-model").length, 2,
    "the cost read-model keeps one provider-local point per cost section");
  equal(cost.spread.find((point) => point.model === "old-model").provider, "codex",
    "historical cost-only models remain in the provider cost data");
  deepEqual(cost.sections.map((section) => section.provider), ["codex", "ollama"]);
  equal(cost.sections.find((section) => section.provider === "codex").spread.length, 2);
});

// ── cost ────────────────────────────────────────────────────────────────────

// Multiplier rows as `multipliers(costPerModel(snaps))` emits them. `m-thin`
// is measured but under the 200-request confidence bar (so it is NOT eligible
// to be the floor); `m-unpriced` has no history at all (a Claude tier reads
// the same). m-cheap carries six leaves so its weighted score survives
// shrinkage and can dominate m-thin on both axes.
const costRow = (model, mult, over = {}) => ({
  model, mult,
  ptsPerReq: mult == null ? null : mult * 0.025,
  requests: 300, measuredRequests: 300, weeks: 1, measuredWeeks: 1,
  ...over,
});
const costRowsFor = () => [
  costRow("m-cheap", 1),
  costRow("m-dear", 4.4),
  costRow("m-thin", 3, { measuredRequests: 100, requests: 100 }),
  costRow("m-unpriced", null, { ptsPerReq: null, requests: 150, measuredRequests: 0, weeks: 1, measuredWeeks: 0 }),
];

test("cost: points join the frontier's verdict — multiplier, band, domination, thin", () => {
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => graded({ leaf: `a${i}`, model: "m-cheap", grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8 } })),
    ...Array.from({ length: 6 }, (_, i) => graded({ leaf: `b${i}`, model: "m-dear", grades: { adherence: 9, handoff: 9, truthfulness: 9, depth: 9 } })),
    graded({ leaf: "c1", model: "m-thin", grades: { adherence: 3, handoff: 3, truthfulness: 3, depth: 3 } }),
    graded({ leaf: "d1", model: "m-unpriced", grades: { adherence: 7, handoff: 7, truthfulness: 7, depth: 7 } }),
  ];
  const { points, spread, bands } = costView(rows, costRowsFor());
  deepEqual(bands, DEFAULT_COST_BANDS, "bands pass through by default");
  const cheap = points.find((p) => p.model === "m-cheap");
  const dear = points.find((p) => p.model === "m-dear");
  const thin = points.find((p) => p.model === "m-thin");
  const unpriced = points.find((p) => p.model === "m-unpriced");
  ok(cheap.onFrontier, "the cheapest model cannot be dominated");
  equal(cheap.band, 1, "1× lands in the first band");
  equal(cheap.multiplier, 1);
  ok(dear.onFrontier, "dearer but strictly better — nothing beats it on both axes");
  equal(dear.band, 2, "4.4× is inside the default 2..5 band");
  equal(thin.dominatedBy, "m-cheap", "strictly worse AND strictly dearer — the frontier's verdict joins in");
  equal(thin.thin, true, "under 200 measured requests is flagged, so the mark can show it");
  equal(unpriced.multiplier, null, "no history is unmeasured, not free");
  equal(unpriced.band, null);
  equal(unpriced.onFrontier, false, "unmeasured neither sits on nor is pushed off the frontier");
  equal(unpriced.dominatedBy, null);
});

test("cost: spread is cheapest-first with unmeasured last, and every row carries its evidence", () => {
  const { spread } = costView([], costRowsFor());
  deepEqual(spread.map((s) => s.model), ["m-cheap", "m-thin", "m-dear", "m-unpriced"],
    "multiplier order, not quality order — this is the cost axis alone");
  const unpriced = spread[3];
  equal(unpriced.mult, null);
  equal(unpriced.band, null);
  equal(unpriced.thin, true, "0 measured requests is thin");
  ok(spread.every((s) => "requests" in s && "measuredRequests" in s && "weeks" in s && "measuredWeeks" in s),
    "the evidence columns ride along so the page can label thin rows");
});

test("cost: custom bands re-map the band column", () => {
  const { bands, spread } = costView([], costRowsFor(), { bands: [0.5, 2] });
  deepEqual(bands, [0.5, 2], "config bands pass through");
  equal(spread.find((s) => s.model === "m-cheap").band, 2, "1× is inside 0.5..2");
  equal(spread.find((s) => s.model === "m-dear").band, 3, "4.4× is over the second edge");
  equal(spread.find((s) => s.model === "m-thin").band, 3, "3× is over the second edge too");
});

// ── best / worst value cards ──────────────────────────────────────────────
// The two verdicts the cost screen puts on cards. Every fixture below pins
// EVERY model's multiplier, because a ratio derivation must be able to
// disagree with the rule — see the row-4 test.
const g4 = (leaf, model, s) => graded({ leaf, model, grades: { adherence: s, handoff: s, truthfulness: s, depth: s } });
const many = (model, s, n = 6) => Array.from({ length: n }, (_, i) => g4(`${model}${i}`, model, s));

test("best: the highest-quality FRONTIER member — never an unmeasured model that outscores it", () => {
  // The onFrontier filter's real bite is UNMEASURED models, not dominated ones:
  // the top-wtd model can never be dominated (domination needs someone strictly
  // better), so among priced models the filter is a no-op. An unpriced model,
  // though, sits in `points` with onFrontier false and can top the wtd column —
  // and naming it "best value" would price something the history never priced.
  const rows = [...many("v-mid", 8), ...many("v-low", 4), ...many("v-unpriced", 9)];
  const costs = [
    costRow("v-mid", 1), costRow("v-low", 3),
    costRow("v-unpriced", null, { ptsPerReq: null, requests: 150, measuredRequests: 0, weeks: 1, measuredWeeks: 0 }),
  ];
  const { best, points } = costView(rows, costs);
  equal(points.find((p) => p.model === "v-unpriced").wtd > best.wtd, true, "fixture precondition: the unpriced model outscores the pick");
  equal(best.model, "v-mid", "best must come from the frontier, not the top of the whole list");
  equal(best.onFrontier, true);
});

test("best: ties break on the cheaper model, then the name", () => {
  const rows = [...many("t-a", 8), ...many("t-b", 8)];
  const { best } = costView(rows, [costRow("t-a", 3), costRow("t-b", 1)]);
  equal(best.model, "t-b", "equal quality — the cheaper wins");
});

test("worst: the DEAREST dominated model, naming its dominator", () => {
  // w-dearest-frontier is dearer than every dominated model, so a derivation
  // that drops the dominatedBy filter picks it and this row goes red.
  const rows = [...many("w-cheap", 9), ...many("w-mid", 5), ...many("w-bad", 4), ...many("w-dearest-frontier", 10)];
  const costs = [costRow("w-cheap", 1), costRow("w-mid", 3), costRow("w-bad", 6), costRow("w-dearest-frontier", 9)];
  const { worst } = costView(rows, costs);
  equal(worst.model, "w-bad", "the dearest model something beats on both axes");
  equal(worst.dominatedBy, "w-cheap", "and it names the model that beat it");
});

test("best/worst are null — never a fabricated pick — when no candidate qualifies", () => {
  // (a) everything on the frontier → nothing is dominated
  const onlyFrontier = costView([...many("n-a", 9), ...many("n-b", 5)], [costRow("n-a", 4), costRow("n-b", 1)]);
  equal(onlyFrontier.worst, null, "no dominated model means no worst — not the cheapest, not points[0]");
  ok(onlyFrontier.best, "…while best still resolves");
  // (b) graded models exist but none is priced → no frontier participant
  const unpriced = costView([...many("u-a", 9)], [costRow("u-a", null, { ptsPerReq: null, requests: 150, measuredRequests: 0, weeks: 1, measuredWeeks: 0 })]);
  ok(unpriced.points.length > 0, "points is non-empty…");
  equal(unpriced.best, null, "…but an unmeasured model is not a frontier member");
  equal(unpriced.worst, null);
  // (c) no cost history at all
  const none = costView([...many("z-a", 9)], []);
  equal(none.best, null);
  equal(none.worst, null);
});

test("best is NOT a quality-per-cost ratio — the rule and the ratio disagree here", () => {
  // Neither dominates the other: 9.5@12x is better but dearer, 3.0@0.6x cheaper
  // but worse. So frontier() keeps both. ratio: 3.0/0.6 = 5.0 beats 9.5/12 = 0.79,
  // so a ratio derivation picks r-cheap and this row fails.
  const rows = [...many("r-good", 9.5), ...many("r-cheap", 3)];
  const { best, points } = costView(rows, [costRow("r-good", 12), costRow("r-cheap", 0.6)]);
  ok(points.find((p) => p.model === "r-good").onFrontier, "fixture precondition: both are on the frontier");
  ok(points.find((p) => p.model === "r-cheap").onFrontier, "fixture precondition: both are on the frontier");
  equal(best.model, "r-good", "domination, not a ratio — scores.mjs rejects collapsing the two axes");
});

test("worst: at equal cost the WORSE model wins the card — lower wtd, not higher", () => {
  // Untested until the code review flagged the gap and read the tie-break the
  // wrong way round. Lower quality at the same price IS the worse value, so the
  // sort is ascending on wtd; this pins the direction against a future "fix".
  const rows = [...many("k-top", 9), ...many("k-better", 5), ...many("k-worse", 3)];
  const costs = [costRow("k-top", 1), costRow("k-better", 4), costRow("k-worse", 4)];
  const { worst } = costView(rows, costs);
  equal(worst.model, "k-worse", "equal multiplier — the lower-quality model is the worse value");
  equal(worst.dominatedBy, "k-top");
});

// ── best value: the cheapest model still worth seating ────────────────────
// The real shape from the store on 2026-09-10: glm-5.3 at 8.99 @ 4.2x and
// glm-5.3-flash at 8.73 @ 1.0x, neither dominating the other. The operator's
// verdict on the old rule: "0.25 is not worth 4x".
const thinRow = (model, mult) => costRow(model, mult, { measuredRequests: 100, requests: 100 });

test("best value: the CHEAPEST frontier member within the margin — not the highest-quality one", () => {
  const rows = [...many("bv-top", 9), ...many("bv-flash", 8.74)];
  const { best } = costView(rows, [costRow("bv-top", 4.2), costRow("bv-flash", 1)]);
  equal(best.model, "bv-flash", "a 0.26 quality gap does not justify 4.2x the cost");
});

test("best value: cheap is not sufficient — a model below the margin is excluded", () => {
  const rows = [...many("m-top", 9), ...many("m-far", 6)];
  const { best } = costView(rows, [costRow("m-top", 4), costRow("m-far", 0.5)]);
  equal(best.model, "m-top", "3.0 below the top is not 'still worth seating' at any price");
});

test("best value: a THIN model is excluded however cheap — the fluke the ratio objection names", () => {
  // nemotron-3-ultra's real shape: 0.6x on 36 measured requests.
  const rows = [...many("t-solid", 9), ...many("t-lucky", 8.9)];
  const { best } = costView(rows, [costRow("t-solid", 4), thinRow("t-lucky", 0.6)]);
  equal(best.model, "t-solid", "a lucky reading on too few requests cannot win on cheapness");
});

test("best value: topWtd comes from the CANDIDATES — a thin high scorer must not raise the bar", () => {
  // h-thin tops the wtd column but is thin. If it set topWtd, h-cheap (8.6)
  // would fall outside the margin and the pick would wrongly be h-mid.
  const rows = [...many("h-thin", 9.9), ...many("h-mid", 8.8), ...many("h-cheap", 8.6)];
  const { best } = costView(rows, [thinRow("h-thin", 3), costRow("h-mid", 4), costRow("h-cheap", 1)]);
  equal(best.model, "h-cheap", "the bar is set by what could actually be picked");
});

test("best value: a dominated model is never picked, however cheap", () => {
  const rows = [...many("d-good", 9), ...many("d-bad", 5)];
  // d-bad is cheaper AND worse -> dominated by d-good, so it is off the frontier.
  const { best, points } = costView(rows, [costRow("d-good", 1), costRow("d-bad", 4)]);
  equal(points.find((p) => p.model === "d-bad").dominatedBy, "d-good", "fixture precondition");
  equal(best.model, "d-good");
});

test("best value: the margin is configurable, and a malformed one falls back to the default", () => {
  const rows = [...many("c-top", 9), ...many("c-flash", 8.74)];
  const costs = [costRow("c-top", 4.2), costRow("c-flash", 1)];
  equal(costView(rows, costs, { valueMargin: 0.1 }).best.model, "c-top", "a tight margin refuses the 0.26 gap");
  equal(costView(rows, costs, { valueMargin: 0.5 }).best.model, "c-flash");
  for (const bad of ["x", -1, null, undefined, NaN]) {
    equal(costView(rows, costs, { valueMargin: bad }).best.model, "c-flash", `malformed ${String(bad)} falls back to the default`);
  }
  equal(costView(rows, costs, { valueMargin: 0.5 }).valueMargin, 0.5, "the resolved margin rides along so the card can name it");
});

test("best value: ties on multiplier break on the better model, then the name", () => {
  const rows = [...many("q-a", 8.9), ...many("q-b", 8.7)];
  const { best } = costView(rows, [costRow("q-a", 2), costRow("q-b", 2)]);
  equal(best.model, "q-a", "same price — take the better one");
});

// ── one section per provider ─────────────────────────────────────────────────
// Three cost lists, one per provider, each ranked within its own accounting
// unit. The rate-card rows come from cost.mjs itself, not a fixture, so this is
// the integration the dashboard actually serves: a Codex or Claude row reaching
// costView and being drawn as a section.

const codexSnaps = [];

test("cost: every provider gets its own section — one list per provider, never merged", () => {
  const rows = [
    ...many("m-meter", 8),
    graded({ leaf: "cx", model: "gpt-5.6-sol", provider: "codex", grades: { adherence: 7, handoff: 7, truthfulness: 7, depth: 7 } }),
    graded({ leaf: "cl", model: "claude-opus-5", provider: "claude", grades: { adherence: 6, handoff: 6, truthfulness: 6, depth: 6 } }),
  ];
  const costRows = [
    costRow("m-meter", 1, { provider: "ollama" }),
    ...providerCostRows("codex", { models: ["gpt-5.6-sol"], snaps: codexSnaps }),
    ...providerCostRows("claude", { models: ["claude-opus-5"], snaps: codexSnaps }),
  ];
  const view = costView(rows, costRows);
  deepEqual(view.sections.map((s) => s.provider), ["claude", "codex", "ollama"],
    "RED: a provider's rows were merged into another provider's section");
  for (const section of view.sections) {
    ok(section.spread.every((r) => r.provider === section.provider),
      `${section.provider}'s section carries another provider's row`);
    ok(section.points.every((p) => (p.provider || "unqualified") === section.provider));
  }
  // A section per provider is not a ranking ACROSS providers. The global cards
  // must stay null on a mixed view: a published Codex price and a measured
  // Ollama meter point do not share an axis, so there is no cross-provider
  // "cheapest model" to name. Two guards hold this — `verdicts` refuses on more
  // than one cost domain, and costView refuses a global verdict unless exactly
  // one provider is present. Removing EITHER alone is still safe; removing both
  // ships the cross-provider ranking, and that is what these two lines catch.
  equal(view.best, null, "RED: a global best was named across incommensurable units");
  equal(view.worst, null, "RED: a global worst was named across incommensurable units");
});

// The Claude panel was entirely empty on the dashboard and read as broken. An
// `unpriced` ROW is the honest alternative, and it is a row the page can draw.
test("cost: a provider with no cost source renders an unpriced ROW, never an empty panel", () => {
  // Rosalind is in the rate cards Chat table and absent from the Work/Codex
  // one the card is read from, so it is genuinely unpriced for a Codex seat.
  const rows = [graded({ leaf: "cx", model: "gpt-rosalind-research", provider: "codex", grades: { adherence: 7, handoff: 7, truthfulness: 7, depth: 7 } })];
  const costRows = providerCostRows("codex", { models: ["gpt-rosalind-research"], snaps: codexSnaps });
  const view = costView(rows, costRows);
  const codex = view.sections.find((s) => s.provider === "codex");
  ok(codex, "RED: a provider with cost rows produced no section at all");
  const spread = codex.spread.find((r) => r.model === "gpt-rosalind-research");
  ok(spread, "RED: the model was dropped from the spread — a blank panel reads as broken");
  equal(spread.mult, null, "RED: a weight was invented for a model with no published price");
  equal(spread.classification, "unpriced", "the row says why it is unmeasured");
  equal(spread.band, null);
  const point = codex.points.find((p) => p.model === "gpt-rosalind-research");
  equal(point.multiplier, null, "unmeasured is not free");
  equal(point.classification, "unpriced", "RED: the point carried no classification, so the page could not say unpriced");
  equal(point.unit, costRows[0].unit, "the point states which unit its weight would be in");
  equal(point.baseModel, "gpt-5.6-luna", "the point names what it is relative to");
});

// ── the Performance ranking's supersession ──────────────────────────────────

// Operator, 2026-09-26: "Hide, toggle to show" — a superseded model left the
// ranked list, the same rule `swarm models` and the Cost screen already keep.
test("rankCells: a superseded model leaves the ranking until the toggle shows it", () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => graded({ leaf: `old${i}`, provider: "ollama", model: "deepseek-v4-flash:cloud", grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8 } })),
    ...Array.from({ length: 5 }, (_, i) => graded({ leaf: `new${i}`, provider: "ollama", model: "deepseek-v4.1-flash:cloud", grades: { adherence: 9, handoff: 9, truthfulness: 9, depth: 9 } })),
  ];
  const cells = rankCells(overall(rows, { combineProviders: true }).cells);
  deepEqual(cells.filter((c) => !c.supersededBy).map((c) => c.model), ["deepseek-v4.1-flash:cloud"],
    "the default ranking is the visible rows only");
  equal(cells.find((c) => c.model === "deepseek-v4-flash:cloud").supersededBy, "deepseek-v4.1-flash:cloud",
    "the toggle has a row to bring back, and it names what replaced it");
});

// The denylist is the same predicate `swarm models` uses: a superseder the
// account cannot run must not hide its elder from the ranking either.
test("rankCells: a superseder that is not launchable leaves its elder ranked", () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => graded({ leaf: `o${i}`, provider: "ollama", model: "deepseek-v4-flash:cloud", grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8 } })),
    ...Array.from({ length: 5 }, (_, i) => graded({ leaf: `n${i}`, provider: "ollama", model: "deepseek-v4.1-flash:cloud", grades: { adherence: 9, handoff: 9, truthfulness: 9, depth: 9 } })),
  ];
  const cells = rankCells(overall(rows, { combineProviders: true }).cells, { isDenylisted: (m) => m === "deepseek-v4.1-flash:cloud" });
  equal(cells.find((c) => c.model === "deepseek-v4-flash:cloud").supersededBy, undefined);
});
