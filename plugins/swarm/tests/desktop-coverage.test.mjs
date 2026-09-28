// Coverage on a desktop is the wireframe's table — a 180px model column, one fr column
// per aspect, each cell a count on a tint — not the phone's SVG stretched until its
// in-drawing text is several times its size.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate } from "../src/scores.mjs";
import { coverage } from "../src/serve/perf-views.mjs";
import { loadPerfViews, H } from "./helpers/perf-views-harness.mjs";

const row = (model, aspect) => ({ leaf: `${model}-${aspect}-${Math.random()}`, model, provider: "ollama", domain: "node", outcome: "completed", grades: { [aspect]: 8 } });
const view = () => coverage(aggregate([
  ...Array.from({ length: 6 }, () => row("m1", "adherence")), row("m1", "truthfulness"), row("m2", "handoff"),
]));
const count = (s, re) => (s.match(re) || []).length;

test("desktop: coverage is the design's table — a model column, one column per aspect, a count per cell", () => {
  const data = view();
  const html = loadPerfViews().coverageGrid(data, { ...H, desktop: true });
  assert.doesNotMatch(html, /<svg/, "no stretched SVG on a desktop");
  const cols = `grid-template-columns:180px repeat(${data.aspects.length},minmax(0,1fr))`;
  assert.equal(count(html, new RegExp(cols.replace(/[()]/g, "\\$&"), "g")), 1 + data.models.length, "header and every row share one column template");
  assert.match(html, /<span>model<\/span>/);
  assert.match(html, />truth</, "5-letter aspect captions");
  assert.equal(count(html, /class="cvcell/g), data.models.length * data.aspects.length, "a cell for every model × aspect");
  assert.match(html, /data-href="#\/perf\/model\/m1"/, "a row opens its model");
});

test("desktop: a cell's tint says how well-sampled it is — none, provisional, measured", () => {
  const html = loadPerfViews().coverageGrid(view(), { ...H, desktop: true });
  assert.match(html, /class="cvcell none"[^>]*>0</, "an untouched pair is the neutral cell");
  assert.match(html, /class="cvcell prov"[^>]*>1</, "under five samples is provisional");
  assert.match(html, /class="cvcell"[^>]*--cv:[\d.]+[^>]*>6</, "a measured count carries its depth");
});

test("phone: the coverage grid stays the SVG it was", () => {
  const data = view();
  const svg = loadPerfViews().coverageGrid(data, H);
  assert.match(svg, /<svg viewBox="0 0 (\d+) /);
  assert.equal(Number(/viewBox="0 0 (\d+) /.exec(svg)[1]) / data.aspects.length, 34);
  assert.doesNotMatch(svg, /<svg[^>]*style=/, "no desktop sizing leaks onto the phone");
});
