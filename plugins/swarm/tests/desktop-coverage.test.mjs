// The coverage grid draws its labels inside one SVG, so on a desktop-wide main an
// uncapped grid scales its 9-10px text several times over. A cap tied to the grid's
// own design width keeps the phone (narrower than the cap) exactly as it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate } from "../src/scores.mjs";
import { coverage } from "../src/serve/perf-views.mjs";
import { loadPerfViews, H } from "./helpers/perf-views-harness.mjs";

const row = (model, aspect) => ({ leaf: `${model}-${aspect}`, model, provider: "ollama", domain: "node", outcome: "completed", grades: { [aspect]: 8 } });

test("the coverage grid is capped at 1.5x its design width", () => {
  const view = coverage(aggregate([row("m1", "adherence"), row("m1", "depth"), row("m2", "handoff")]));
  const svg = loadPerfViews().coverageGrid(view, H);
  const vbW = Number(/viewBox="0 0 (\d+(?:\.\d+)?) /.exec(svg)[1]);
  const cap = /<svg[^>]*style="max-width:(\d+(?:\.\d+)?)px"/.exec(svg);
  assert.ok(cap, "the grid carries a max-width");
  assert.equal(Number(cap[1]), vbW * 1.5);
});
