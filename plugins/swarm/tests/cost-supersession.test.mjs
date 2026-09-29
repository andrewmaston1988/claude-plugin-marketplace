import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { costView } from "../src/serve/perf-views.mjs";
import { costSections } from "../src/cost.mjs";
import { dropSuperseded } from "../src/discovery.mjs";
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
