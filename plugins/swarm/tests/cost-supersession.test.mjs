import { test } from "node:test";
import { equal } from "node:assert/strict";
import { costView } from "../src/serve/perf-views.mjs";
import { H, loadPerfViews } from "./helpers/perf-views-harness.mjs";

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
  equal(point("claude-opus-5").onFrontier, false);
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

test("a denylisted newest model does not hide its elder in costView", () => {
  const old = "claude-opus-5";
  const newest = "claude-opus-5-5";
  const rows = [...grades(old, 7), ...grades(newest, 8)];
  const view = costView(rows, [cost(old, 2), cost(newest, 1)], {
    isDenylisted: (model) => model === newest,
  });

  equal(view.points.find((row) => row.model === old).supersededBy, undefined);
  equal(view.spread.find((row) => row.model === old).supersededBy, undefined);
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
  const html = modelDashboard({
    model: "claude-opus-5",
    overall: null,
    rank: null,
    aspects: [],
    coverage: { aspects: [], models: [], cells: [] },
    reliability: [],
    domainSelect: null,
    domain: null,
    cost: { provider: "claude", onFrontier: true, supersededBy: "claude-opus-5-5" },
  }, { ...H, badge: () => "<b>cost chip</b>" });

  equal(html.includes("cost chip"), true);
});
