import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { costView } from "../src/cost-view.mjs";
import { DEFAULT_COST_BANDS, costRowsFor as providerCostRows } from "../src/cost.mjs";
import { loadPerfViews } from "./helpers/perf-views-harness.mjs";
import { graded, costRow } from "./helpers/perf-rows.mjs";

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
  // here the top-wtd priced model is dominated only by an equal-score, cheaper
  // row, so among priced models the filter is nearly a no-op. An unpriced model,
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

// `costHero` was split out of costSection so a screen can draw the hero without the ranked
// cards, and the Overview reaches it through perfViews' own surface: the signature is a
// contract two files share, not an internal detail — a third parameter nothing reads is a
// contract that lies about what the hero needs.
test("costHero reads its section and the page's helpers, and no more", () => {
  const V = loadPerfViews();
  equal(V.costHero.length, 2, "the hero takes (section, h) — the data payload is not its input");
  equal(typeof V.noCost, "function", "the Cost screen's own empty state is on the same surface");
  ok(V.noCost().includes("no cost history yet"), "and it is the words a screen short of history draws");
});

// ── elder exclusion and equal-cost ties ───────────────────────────────────
// Claude-shaped fixtures: `claude-opus-5` has a successor with one grade, so it
// is a pending elder (kept on the view, never the pick while others remain).
const claudeCost = (model, mult) => costRow(model, mult, { provider: "claude", unit: "usd", costDomain: "claude:usd:rate-card" });
const claudeMany = (model, s, n = 6) => Array.from({ length: n }, (_, i) => graded({
  leaf: `${model}${i}`, provider: "claude", model, grades: { adherence: s, handoff: s, truthfulness: s, depth: s },
}));
const claudeSection = (rows, costs) => costView(rows, costs).sections.find((s) => s.provider === "claude");

test("best: a pending elder neither wins the card nor sets the margin's top while another candidate remains", () => {
  const rows = [...claudeMany("claude-opus-5", 9), ...claudeMany("claude-opus-5-5", 5, 1), ...claudeMany("claude-sonnet-5-5", 8)];
  const section = claudeSection(rows, [claudeCost("claude-opus-5", 2.5), claudeCost("claude-opus-5-5", 4), claudeCost("claude-sonnet-5-5", 1)]);
  const elder = section.points.find((p) => p.model === "claude-opus-5");
  equal(elder.pendingSuccessor, "claude-opus-5-5", "fixture precondition: the elder is pending, not superseded");
  equal(elder.onFrontier, true, "fixture precondition: the elder is on the frontier and outscores the pick by more than the margin");
  equal(section.best.model, "claude-sonnet-5-5", "RED: the elder set topWtd, pushed sonnet outside the 0.5 margin and took the card");
});

test("dominance: a pending elder still dominates a same-cost lower-scoring row", () => {
  const rows = [...claudeMany("claude-opus-5", 9), ...claudeMany("claude-opus-5-5", 5, 1), ...claudeMany("claude-haiku-5", 8)];
  const { points } = costView(rows, [claudeCost("claude-opus-5", 2.5), claudeCost("claude-opus-5-5", 4), claudeCost("claude-haiku-5", 2.5)]);
  equal(points.find((p) => p.model === "claude-haiku-5").dominatedBy, "claude/claude-opus-5",
    "RED: equal cost never counted as dominance, so the lower row stayed on the frontier");
});

test("dominance: at equal cost the lower score is dominated; identical score and cost are not", () => {
  const by = (view, m) => view.points.find((p) => p.model === m);
  const tied = costView([...many("e-hi", 8), ...many("e-lo", 6)], [costRow("e-hi", 1), costRow("e-lo", 1)]);
  equal(by(tied, "e-lo").dominatedBy, "e-hi", "RED: equal cost with a lower score was left on the frontier");
  equal(by(tied, "e-hi").onFrontier, true);
  const exact = costView([...many("x-a", 8), ...many("x-b", 8)], [costRow("x-a", 1), costRow("x-b", 1)]);
  equal(by(exact, "x-a").dominatedBy, null, "guard: exact equality on both axes is not dominance");
  equal(by(exact, "x-b").dominatedBy, null);
});
