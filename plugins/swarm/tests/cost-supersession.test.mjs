import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { costView, rankCells, successorPitch } from "../src/serve/perf-views.mjs";
import { overall } from "../src/scores.mjs";
import { costSections } from "../src/cost.mjs";
import { dropSuperseded } from "../src/supersession.mjs";
import { rateCards } from "../src/rate-card.mjs";
import { H, loadPerfViews } from "./helpers/perf-views-harness.mjs";
import { snap, seg } from "./helpers/cost-snapshots.mjs";

const grades = (model, score) => Array.from({ length: 6 }, (_, i) => ({
  resultsDir: "C:/runs/cost-supersession",
  leaf: `${model}-${i}`,
  provider: "claude",
  model,
  domain: "godot",
  grades: { adherence: score, handoff: score, truthfulness: score, depth: score },
  outcome: "completed",
  note: "",
  assessedBy: { session: "s" },
}));

const cost = (model, mult) => ({
  provider: "claude",
  model,
  mult,
  requests: 300,
  measuredRequests: 300,
  weeks: 1,
  measuredWeeks: 1,
  unit: "usd",
  costDomain: "claude:usd:rate-card",
});

test("costView marks superseded point and spread rows before verdicts and frontier", () => {
  const rows = [
    ...grades("claude-opus-5", 10),
    ...grades("claude-opus-5-5", 8),
    ...grades("claude-haiku-5", 7),
  ];
  const view = costView(rows, [
    cost("claude-opus-5", 1),
    cost("claude-opus-5-5", 4),
    cost("claude-haiku-5", 3),
  ]);
  const point = (model) => view.points.find((row) => row.model === model);
  const spread = (model) => view.spread.find((row) => row.model === model);

  equal(point("claude-opus-5").supersededBy, "claude-opus-5-5");
  equal(spread("claude-opus-5").supersededBy, "claude-opus-5-5");
  equal(point("claude-opus-5").dominatedBy, null);
  equal(point("claude-opus-5").onFrontier, true);
  equal(point("claude-haiku-5").dominatedBy, null);
  equal(point("claude-haiku-5").onFrontier, true);
  equal(view.best.model, "claude-opus-5-5");
  equal(spread("claude-opus-5-5").supersededBy, undefined);
  equal(point("claude-opus-5-5").supersededBy, undefined);
});

test("costView never chooses a superseded row as worst", () => {
  const rows = [
    ...grades("claude-opus-5", 3),
    ...grades("claude-opus-5-5", 8),
    ...grades("claude-sonnet-5", 7),
  ];
  const view = costView(rows, [
    cost("claude-opus-5", 4),
    cost("claude-opus-5-5", 1),
    cost("claude-sonnet-5", 2),
  ]);

  equal(view.worst?.model, "claude-sonnet-5");
  equal(view.points.find((row) => row.model === "claude-opus-5").supersededBy, "claude-opus-5-5");
});

test("a denylisted newest model hides its elder in costView", () => {
  // Cost is a price reference, not a dispatch roster: both models here are
  // denylisted and the elder still goes, because the newest of a family is the
  // one whose price anyone reading this screen wants.
  const old = "claude-fable-5";
  const newest = "claude-fable-5-1";
  const rows = [...grades(old, 7), ...grades(newest, 8)];
  const view = costView(rows, [cost(old, 5), cost(newest, 5)], { isDenylisted: () => true });

  equal(view.points.find((row) => row.model === old).supersededBy, newest);
  equal(view.spread.find((row) => row.model === old).supersededBy, newest);
});

test("costView reads no denylist at all, so nothing on Cost can resurrect an elder", () => {
  const old = "claude-opus-5";
  const newest = "claude-opus-5-5";
  const rows = [...grades(old, 7), ...grades(newest, 8)];
  const costs = [cost(old, 2), cost(newest, 1)];

  deepEqual(costView(rows, costs, { isDenylisted: () => true }), costView(rows, costs),
    "RED: the denylist can still move what Cost shows");
});

test("superseded points get verdicts from visible rows but never dominate them", () => {
  const old = "claude-opus-5";
  const current = "claude-opus-5-5";
  const visible = "claude-haiku-5";
  const rows = [...grades(old, 4), ...grades(current, 6), ...grades(visible, 5)];
  const view = costView(rows, [cost(old, 4), cost(current, 5), cost(visible, 3)]);
  const point = (model) => view.points.find((row) => row.model === model);

  equal(point(old).supersededBy, current);
  equal(point(old).onFrontier, false);
  equal(point(old).dominatedBy, `claude/${visible}`);
  equal(point(current).onFrontier, true);
  equal(point(current).dominatedBy, null);
  equal(point(visible).onFrontier, true);
  equal(point(visible).dominatedBy, null);
});

test("costView uses the configured Ollama cloud suffix for model families", () => {
  const old = "kimi-k3:0901-local";
  const current = "kimi-k3.1:local";
  const rows = [...grades(old, 7), ...grades(current, 8)].map((row) => ({ ...row, provider: "ollama" }));
  const costs = [cost(old, 2), cost(current, 1)].map((row) => ({ ...row, provider: "ollama" }));
  const view = costView(rows, costs, { cloudSuffix: ":local" });

  equal(view.points.find((row) => row.model === old).supersededBy, current);
});

test("costView never supersedes the card's own base model", () => {
  // `claude-sonnet-5` is the 1x unit the section label names; once a refresh prices
  // `claude-sonnet-5-5` it is the elder of its family and would leave the screen.
  const base = "claude-sonnet-5";
  const newer = "claude-sonnet-5-5";
  const priced = (model, mult) => ({ ...cost(model, mult), baseModel: base });
  const view = costView(
    [...grades(base, 7), ...grades(newer, 8), ...grades("claude-opus-5", 6), ...grades("claude-opus-5-5", 5)],
    [priced(base, 1), priced(newer, 1), priced("claude-opus-5", 5), priced("claude-opus-5-5", 5)],
  );
  const point = (model) => view.points.find((row) => row.model === model);

  equal(point(base).supersededBy, undefined, "RED: the 1x row left the Cost screen");
  equal(view.spread.find((row) => row.model === base).supersededBy, undefined,
    "RED: the 1x row left the spread table");
  // Supersession still runs for every family but that one.
  equal(point("claude-opus-5").supersededBy, "claude-opus-5-5");
});

// ── the handover waits for the successor's grades ───────────────────────────
// An ungraded successor erased its elder: Sonnet 5's point and best-value
// verdict vanished when Sonnet 5.5 appeared with nothing to plot. On a graded
// view the elder now leaves only once the successor has the evidence to take
// over — the same n>=5 the ranking already calls provisional.
const handoverRows = (elder, successor, n) => ({
  rows: [...grades(elder, 10), ...grades(successor, 6).slice(0, n)],
  costs: [cost(elder, 1), cost(successor, 4)],
});

test("four grades hand nothing over: the elder stays, pending, and still leads", () => {
  const old = "claude-opus-5", next = "claude-opus-5-5";
  const { rows, costs } = handoverRows(old, next, 4);
  const view = costView(rows, costs);
  const point = (model) => view.points.find((row) => row.model === model);
  const spread = (model) => view.spread.find((row) => row.model === model);

  equal(point(old).supersededBy, undefined, "the elder is not superseded while the successor is ungraded enough to be a coin toss");
  equal(point(old).pendingSuccessor, next);
  equal(spread(old).pendingSuccessor, next);
  equal(point(next).pendingSuccessor, undefined, "only the row under a successor carries the flag");
  equal(view.best.model, old, "the pending elder is still eligible for best value");
});

test("five grades hand over: the elder is superseded and leaves the verdict", () => {
  const old = "claude-opus-5", next = "claude-opus-5-5";
  const { rows, costs } = handoverRows(old, next, 5);
  const view = costView(rows, costs);

  equal(view.points.find((row) => row.model === old).supersededBy, next);
  equal(view.points.find((row) => row.model === old).pendingSuccessor, undefined);
  equal(view.best.model, next);
});

test("an outcome-only successor has earned no handover, whatever provisional says", () => {
  // n=0 with provisional=false is the shape that would pass a provisional test:
  // failed rows create the cell, count an outcome, and grade nothing.
  const old = "claude-opus-5", next = "claude-opus-5-5";
  const rows = [
    ...grades(old, 8),
    ...Array.from({ length: 3 }, (_, i) => ({
      resultsDir: "C:/runs/cost-supersession",
      leaf: `${next}-dead-${i}`,
      provider: "claude",
      model: next,
      domain: "godot",
      grades: null,
      outcome: "failed",
      note: "",
    })),
  ];
  const view = costView(rows, [cost(old, 2), cost(next, 1)]);

  equal(view.points.find((row) => row.model === next), undefined, "no grade, no point");
  equal(view.points.find((row) => row.model === old).supersededBy, undefined);
  equal(view.points.find((row) => row.model === old).pendingSuccessor, next);
  equal(view.best.model, old);
});

test("readiness is per provider: one provider's grades never retire a same-named model under another", () => {
  const under = (provider, model, n) => Array.from({ length: n }, (_, i) => ({
    resultsDir: `C:/runs/${provider}-${model}-${i}`,
    leaf: `${model}-${i}`,
    provider,
    model,
    domain: "godot",
    grades: { adherence: 9, handoff: 9, truthfulness: 9, depth: 9 },
    outcome: "completed",
    note: "",
  }));
  const price = (provider, model, mult) => ({ ...cost(model, mult), provider });
  const rows = [
    ...under("alpha", "m-1", 6), ...under("alpha", "m-2", 2),
    ...under("beta", "m-1", 6), ...under("beta", "m-2", 7),
  ];
  const view = costView(rows, [price("alpha", "m-1", 2), price("beta", "m-1", 2), price("alpha", "m-2", 1), price("beta", "m-2", 1)]);
  const point = (provider, model) => view.points.find((row) => row.provider === provider && row.model === model);

  equal(point("alpha", "m-1").supersededBy, undefined);
  equal(point("alpha", "m-1").pendingSuccessor, "m-2", "alpha's successor has two grades and retires nothing");
  equal(point("beta", "m-1").supersededBy, "m-2", "beta's successor has seven and takes the handover");
});

test("rankCells keeps an elder whose successor is under five grades", () => {
  const old = "claude-opus-5", next = "claude-opus-5-5";
  const cellsFor = (n) => rankCells(overall(handoverRows(old, next, n).rows, { combineProviders: true }).cells);
  const cell = (cells, model) => cells.find((c) => c.model === model);

  equal(cell(cellsFor(4), old).supersededBy, undefined);
  equal(cell(cellsFor(4), old).pendingSuccessor, next);
  equal(cell(cellsFor(5), old).supersededBy, next);
  equal(cell(cellsFor(5), old).pendingSuccessor, undefined);
});

test("a pending elder is never named worst, and is still pending", () => {
  const elder = "claude-opus-5", successor = "claude-opus-5-5", other = "claude-sonnet-5";
  const rows = [...grades(elder, 3), ...grades(successor, 9).slice(0, 2), ...grades(other, 4)];
  const view = costView(rows, [cost(elder, 9), cost(successor, 1), cost(other, 5)]);

  // The elder is the dearest dominated row, so it would win `worst` on sort
  // order alone the moment it stopped being superseded.
  equal(view.points.find((row) => row.model === elder).pendingSuccessor, successor);
  equal(view.worst?.model, other);
});

test("successorPitch names the elder, its rank and its verdicts — or says there is none", () => {
  equal(successorPitch({ elder: "claude-sonnet-5", rank: 2, verdicts: ["best value"] }),
    "needs grades — newer generation of claude-sonnet-5 (#2 overall, best value)");
  equal(successorPitch({ elder: "claude-sonnet-5", rank: 7 }), "needs grades — newer generation of claude-sonnet-5",
    "no verdict is no claim, and a middling rank is not one either");
  equal(successorPitch({ elder: "claude-sonnet-5", verdicts: ["frontier"] }),
    "needs grades — newer generation of claude-sonnet-5 (frontier)");
  equal(successorPitch({ n: 3 }), "needs grades, n=3", "no predecessor, so the only fact is its own n");
});

test("costScreen hides superseded cards and never names one as the hero leader", () => {
  const { costScreen } = loadPerfViews();
  const old = "claude-opus-5";
  const current = "claude-opus-5-5";
  const html = costScreen({ sections: [{
    provider: "claude",
    points: [
      { model: old, wtd: 10, multiplier: 1, onFrontier: true, dominatedBy: null, supersededBy: current },
      { model: current, wtd: 8, multiplier: 4, onFrontier: true, dominatedBy: null },
      { model: "claude-haiku-5", wtd: 7, multiplier: 3, onFrontier: true, dominatedBy: null },
    ],
    spread: [
      { model: old, mult: 1, supersededBy: current },
      { model: current, mult: 4 },
      { model: "claude-haiku-5", mult: 3 },
    ],
    best: { model: current, wtd: 8, multiplier: 4 },
    worst: null,
  }] }, H, "claude");

  equal(html.includes(`data-href="#/perf/model/${old}"`), false);
  equal(html.includes("claude-opus-5's score"), false);
  equal(html.includes('data-href="#/perf/model/claude-haiku-5"'), true);
});

test("the perf model page keeps the cost chip for a superseded model", () => {
  const { modelDashboard } = loadPerfViews();
  const old = "claude-opus-5";
  const current = "claude-opus-5-5";
  const rows = [...grades(old, 10), ...grades(current, 8), ...grades("claude-haiku-5", 7)];
  const view = costView(rows, [cost(old, 1), cost(current, 4), cost("claude-haiku-5", 3)]);
  const costPoint = view.points.find((row) => row.model === old);
  const html = modelDashboard({
    model: old,
    overall: null,
    rank: null,
    aspects: [],
    coverage: { aspects: [], models: [], cells: [] },
    reliability: [],
    domainSelect: null,
    domain: null,
    cost: costPoint,
  }, { ...H, badge: (point) => `<span class="cbadge coins" data-coins="${point.coins}"></span>` });

  equal(costPoint.supersededBy, current);
  equal(costPoint.coins > 0, true);
  equal(html.includes(`data-coins="${costPoint.coins}"`), true);
  equal(html.includes('<span class="vchip front">frontier</span>'), true);
});

// `swarm cost` prints one section per provider, and it is the same table the
// dashboard draws — so it drops the same rows, by the same reading, with no
// denylist of its own.
test("dropSuperseded honours the denylist it is handed, as supersededByMap does", () => {
  // The table form shares the map's reading; an option it swallowed in silence
  // would be a no-op that no caller could see.
  const rows = [{ provider: "claude", model: "claude-opus-5" }, { provider: "claude", model: "claude-opus-5-5" }];
  const providerKey = (row) => row.provider;

  deepEqual(dropSuperseded(rows, { providerKey, isDenylisted: (model) => model === "claude-opus-5-5" })
    .map((row) => row.model), ["claude-opus-5", "claude-opus-5-5"],
  "RED: a denylisted superseder still hid its elder");
  deepEqual(dropSuperseded(rows, { providerKey }).map((row) => row.model), ["claude-opus-5-5"]);
});

test("costSections: drops superseded rows and counts them", () => {
  const section = costSections({
    providers: ["claude"],
    models: { claude: ["claude-opus-5", "claude-opus-5-5"] },
  })[0];
  const models = section.rows.map((row) => row.model);

  equal(models.includes("claude-opus-5"), false, "RED: the elder of a family still carries a row");
  equal(models.includes("claude-opus-5-5"), true);
  equal(models.includes("claude-sonnet-5"), true, "the card's base model is the unit and is always listed");
  equal(section.hidden, 1, "RED: the CLI cannot say how many rows it dropped");
});

test("costSections: a superseded base model keeps its row — it IS the unit", () => {
  const provider = "test-superseded-base";
  const cards = rateCards();
  // Two families: the card's own base is the elder of one, and the other is there
  // so the assertion can tell "kept the unit" from "supersession never ran".
  cards[provider] = {
    provider, baseModel: "m-1", unit: "published-price-relative", source: "test-rate-card",
    asOf: new Date().toISOString(),
    prices: {
      "m-1": { input: 2, output: 10 }, "m-2": { input: 4, output: 20 },
      "n-1": { input: 2, output: 10 }, "n-2": { input: 3, output: 15 },
    },
  };
  try {
    const section = costSections({ providers: [provider] })[0];
    const models = section.rows.map((row) => row.model);
    ok(models.includes("m-1"), "RED: the 1x row was dropped, leaving the list without its unit");
    equal(models.includes("n-1"), false, "RED: supersession never ran in this section");
    equal(section.hidden, 1);
  } finally {
    delete cards[provider];
  }
});

test("costSections: the meter's own rows supersede on the configured cloud suffix", () => {
  const snaps = [snap(1, [seg("kimi-k3:cloud", 400, 60), seg("kimi-k3.1:cloud", 400, 40)], 50)];
  const section = costSections({ providers: ["ollama"], snaps })[0];
  const models = section.rows.map((row) => row.model);

  equal(models.includes("kimi-k3:cloud"), false, "RED: the meter's elder row survived the collapse");
  equal(models.includes("kimi-k3.1:cloud"), true);
  equal(section.hidden, 1);
});
