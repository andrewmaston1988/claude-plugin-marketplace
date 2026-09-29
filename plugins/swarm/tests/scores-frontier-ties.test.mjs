import { test } from "node:test";
import { equal } from "node:assert/strict";
import { frontier, dominates } from "../src/scores.mjs";
import { graded } from "./helpers/perf-rows.mjs";

const leaves = (model, g, n = 5) => Array.from({ length: n }, (_, i) => graded({
  resultsDir: `C:/runs/tie-${model}-${i}`, model, grades: { adherence: g, handoff: g, truthfulness: g, depth: g },
}));

test("frontier: at equal cost the lower score is dominated (swarm perf's dom column)", () => {
  const v = frontier([...leaves("hi:cloud", 8), ...leaves("lo:cloud", 6)], [{ model: "hi:cloud", mult: 1 }, { model: "lo:cloud", mult: 1 }], {});
  const by = Object.fromEntries(v.map((x) => [x.model, x]));
  equal(by["lo:cloud"].dominatedBy, "hi:cloud", "RED: equal cost never counted as dominance");
  equal(by["hi:cloud"].onFrontier, true);
});

test("frontier: identical score and cost dominate neither (guard)", () => {
  const v = frontier([...leaves("a:cloud", 8), ...leaves("b:cloud", 8)], [{ model: "a:cloud", mult: 1 }, { model: "b:cloud", mult: 1 }], {});
  equal(v.every((x) => x.onFrontier && x.dominatedBy === null), true);
});

test("dominates: >= on score, <= on cost, at least one strict", () => {
  equal(dominates({ wtd: 8, multiplier: 1 }, { wtd: 6, multiplier: 1 }), true, "same cost, better score");
  equal(dominates({ wtd: 8, multiplier: 1 }, { wtd: 8, multiplier: 2 }), true, "same score, cheaper");
  equal(dominates({ wtd: 8, multiplier: 1 }, { wtd: 8, multiplier: 1 }), false, "exact tie");
  equal(dominates({ wtd: 9, multiplier: 3 }, { wtd: 8, multiplier: 1 }), false, "better but dearer");
});
