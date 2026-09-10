// perf.js is a browser IIFE that assigns `window.perfViews` — a plain node
// import throws `ReferenceError: window is not defined`. So evaluate it in a vm
// against a stub window, the same trick page-route.test.mjs uses for page.html.
// That is what lets these rows run the REAL renderer: a test that stubs
// costScreen and then asserts on the stub's markup asserts nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PERF_JS = readFileSync(fileURLToPath(new URL("../src/serve/perf.js", import.meta.url)), "utf8");

function loadPerfViews() {
  const sandbox = { window: {}, Math, JSON, Object, Array, Number, String, Map, Set, console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(PERF_JS, sandbox, { filename: "perf.js" });
  return sandbox.window.perfViews;
}

const H = {
  esc: (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
  enc: encodeURIComponent,
  fmtScore: (v) => (v == null ? "—" : v.toFixed(2)),
  chip: (label) => `<span class="chip">${label}</span>`,
};

const point = (model, wtd, multiplier, over = {}) => ({
  model, wtd, n: 6, multiplier, band: 1, onFrontier: false, dominatedBy: null, thin: false, ...over,
});
const srow = (model, mult, over = {}) => ({
  model, mult, band: mult == null ? null : 1, requests: 500, measuredRequests: 500, weeks: 3, measuredWeeks: 3,
  thin: false, ...over,
});

test("row 7: the cost screen draws cards and a ranked list — and no plot marks at all", () => {
  const { costScreen } = loadPerfViews();
  const html = costScreen({
    points: [point("a", 8, 1, { onFrontier: true }), point("b", 4, 3, { dominatedBy: "a" })],
    spread: [srow("a", 1), srow("b", 3)],
    bands: [2, 5],
    best: point("a", 8, 1, { onFrontier: true }),
    worst: point("b", 4, 3, { dominatedBy: "a" }),
  }, H);
  assert.ok(html.includes("best value") && html.includes("worst value"), "both verdict cards render");
  assert.ok(html.includes("cost ranking"), "the ranked list renders");
  assert.ok(!html.includes("<circle"), "no plot marks — the scatter and spread are gone, not hidden behind CSS");
  assert.ok(!html.includes("<svg"), "and no chart canvas either");
  assert.ok(html.includes('data-href="#/perf/model/a"'), "a row taps through to its model page");
});

test("row 9: the ranking bar is LOG-scaled over 0.5×–20×, not linear", () => {
  const { costScreen } = loadPerfViews();
  const html = costScreen({
    points: [point("one", 8, 1, { onFrontier: true }), point("two", 7, 2, { onFrontier: true })],
    spread: [srow("one", 1), srow("two", 2)],
    bands: [2, 5], best: point("one", 8, 1, { onFrontier: true }), worst: null,
  }, H);
  const widths = [...html.matchAll(/width:([\d.]+)%/g)].map((m) => Number(m[1]));
  assert.equal(widths.length, 2, "one bar per costed row");
  // Log: 1× lands at (log10(1)-log10(0.5))/(log10(20)-log10(0.5)) ≈ 18.8%.
  // Linear over the same domain would put it at 5% — so this bound is what a
  // linear bar fails. (A ratio between the two bars cannot discriminate: it is
  // 2.0 under both scales, which is why the assertion is on the absolute value.)
  assert.ok(widths[0] > 15 && widths[0] < 23, `1× must sit near 18.8% on a log axis, got ${widths[0]}% (linear would be 5%)`);
  assert.ok(widths[1] > 33 && widths[1] < 42, `2× must sit near 37.6%, got ${widths[1]}%`);
});

test("row 10: a card with no pick draws an em dash AND its reason — never blank, never 0×", () => {
  const { costScreen } = loadPerfViews();
  const html = costScreen({
    points: [point("solo", 8, 1, { onFrontier: true })],
    spread: [srow("solo", 1)],
    bands: [2, 5],
    best: point("solo", 8, 1, { onFrontier: true }),
    worst: null,
  }, H);
  assert.ok(html.includes("nothing is beaten on both axes"), "the empty card says why it is empty");
  assert.ok(html.includes("—"), "and shows an em dash");
  assert.ok(!/worst value<\/label><span>0/.test(html), "never a 0× — that would read as free");
});

test("an unmeasured row draws no bar and keeps its em dash", () => {
  const { costScreen } = loadPerfViews();
  const html = costScreen({
    points: [point("priced", 8, 1, { onFrontier: true })],
    spread: [srow("priced", 1), srow("nohistory", null, { band: null, measuredRequests: 0, measuredWeeks: 0, thin: true })],
    bands: [2, 5], best: point("priced", 8, 1, { onFrontier: true }), worst: null,
  }, H);
  const widths = [...html.matchAll(/width:([\d.]+)%/g)];
  assert.equal(widths.length, 1, "the unmeasured row draws no bar — a 0-width bar would read as free");
  assert.ok(html.includes("unmfirst"), "and sits below a divider");
  assert.ok(html.includes("unmeasured"), "its verdict names the absence");
});

test("a pick with no multiplier renders an em dash, never 0×", () => {
  // costView never produces such a pick — its picks are frontier participants.
  // But costScreen is public on window.perfViews, so the guard lives here too.
  const { costScreen } = loadPerfViews();
  const html = costScreen({
    points: [point("x", 8, null, { onFrontier: true, band: null })],
    spread: [srow("x", null, { band: null })],
    bands: [2, 5],
    best: point("x", 8, null, { onFrontier: true, band: null }),
    worst: null,
  }, H);
  assert.ok(!html.includes("0×"), "an unmeasured pick must never render as 0× — that reads as free");
  assert.ok(html.includes("—"), "it renders an em dash instead");
});

test("row 8: the best-value card names the margin it used", () => {
  const { costScreen } = loadPerfViews();
  const html = costScreen({
    points: [point("a", 8.7, 1, { onFrontier: true })],
    spread: [srow("a", 1)],
    bands: [2, 5], valueMargin: 0.5,
    best: point("a", 8.7, 1, { onFrontier: true }), worst: null,
  }, H);
  assert.ok(html.includes("within 0.5 of the best"), "a threshold the reader cannot see is one they must trust");
});
