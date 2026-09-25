import { test } from "node:test";
import { equal } from "node:assert/strict";
import { costView } from "../src/serve/perf-views.mjs";

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
