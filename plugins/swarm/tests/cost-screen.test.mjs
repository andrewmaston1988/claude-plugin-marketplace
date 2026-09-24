// The Cost screen's renderer, run for real through perf.js (see the harness).
// Mockup 922–983: one provider per page, its value hero,
// then a ranked card per model — or one fact card, never both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPerfViews, H } from "./helpers/perf-views-harness.mjs";

const point = (model, wtd, multiplier, over = {}) => ({
  model, wtd, n: 6, multiplier, band: 1, onFrontier: false, dominatedBy: null, thin: false, ...over,
});
const srow = (model, mult, over = {}) => ({
  model, mult, band: mult == null ? null : 1, requests: 500, measuredRequests: 500, weeks: 3, measuredWeeks: 3,
  thin: false, ...over,
});
const section = (provider, spread, over = {}) => ({ provider, points: [], spread, best: null, worst: null, ...over });
const cards = (html, cls = "crow") => html.match(new RegExp(`class="card ${cls}[^"]*"`, "g")) || [];

test("one page per provider on the Performance switcher, the picked one active, the first by default", () => {
  const { costScreen } = loadPerfViews();
  const data = { sections: [section("claude", [srow("sonnet", 1)]), section("ollama", [srow("glm", 2)])] };
  const first = costScreen(data, H);
  assert.ok(first.includes('<div class="seg"><a data-href="#/cost/claude" class="on">claude</a><a data-href="#/cost/ollama">ollama</a></div>'));
  const picked = costScreen(data, H, "ollama");
  assert.ok(picked.includes('<a data-href="#/cost/ollama" class="on">'));
  assert.ok(picked.includes("glm") && !picked.includes("sonnet"), "only the picked provider's models — multipliers only compare within one");
});

test("each measured model is a ranked card: rank, name, multiplier, bar, verdict — and no chart", () => {
  const { costScreen } = loadPerfViews();
  const html = costScreen({ sections: [section("ollama", [srow("a", 1), srow("b", 3)], {
    points: [point("a", 8, 1, { onFrontier: true }), point("b", 4, 3, { dominatedBy: "a" })],
    best: point("a", 8, 1, { onFrontier: true }), worst: point("b", 4, 3, { dominatedBy: "a" }),
  })] }, H);
  assert.equal(cards(html).length, 2);
  assert.match(html, /class="rk">1<[\s\S]*class="rk">2</, "ranked cheapest first");
  assert.ok(html.includes("3×") && html.includes("best value") && html.includes("beaten by a"));
  assert.ok(html.includes('data-href="#/perf/model/a"'), "a card taps through to its model page");
  assert.ok(!html.includes("<svg"), "no chart canvas");
});

test("the bar is LOG-scaled over 0.5×–20×, not linear", () => {
  const { costScreen } = loadPerfViews();
  const html = costScreen({ sections: [section("ollama", [srow("one", 1), srow("two", 2)])] }, H);
  const widths = [...html.matchAll(/width:([\d.]+)%/g)].map((m) => Number(m[1]));
  assert.equal(widths.length, 2, "one bar per measured card");
  // Log: 1× lands at ≈18.8%; linear over the same domain would put it at 5%.
  assert.ok(widths[0] > 15 && widths[0] < 23, `1× near 18.8% on a log axis, got ${widths[0]}%`);
  assert.ok(widths[1] > 33 && widths[1] < 42, `2× near 37.6%, got ${widths[1]}%`);
});

test("an unmeasured model keeps its card, with no bar and an em dash — never 0×", () => {
  const { costScreen } = loadPerfViews();
  const html = costScreen({ sections: [section("ollama", [srow("priced", 1), srow("nohistory", null, { band: null, measuredRequests: 0, thin: true })])] }, H);
  assert.equal([...html.matchAll(/width:([\d.]+)%/g)].length, 1, "a 0-width bar would read as free");
  assert.equal(cards(html, "crow unm").length, 1);
  assert.ok(html.includes("—") && html.includes("unmeasured") && !html.includes("0×"));
});

test("thin evidence draws a hatched bar and says so", () => {
  const { costScreen } = loadPerfViews();
  const html = costScreen({ sections: [section("ollama", [srow("t", 1, { thin: true, measuredRequests: 40 })])] }, H);
  assert.match(html, /class="cbar thin"/);
  assert.ok(html.includes("thin evidence"));
});

test("the best-value card names the margin it used", () => {
  const { costScreen } = loadPerfViews();
  const html = costScreen({ valueMargin: 0.5, sections: [section("ollama", [srow("a", 1)], {
    points: [point("a", 8.7, 1, { onFrontier: true })], best: point("a", 8.7, 1, { onFrontier: true }),
  })] }, H);
  assert.ok(html.includes("within 0.5 of the best"), "a threshold the reader cannot see is one they must trust");
});

test("a provider with nothing measured draws one fact card, never a list of dashes", () => {
  const { costScreen } = loadPerfViews();
  const html = costScreen({ sections: [section("codex", [srow("x", null, { band: null }), srow("y", null, { band: null })])] }, H);
  assert.equal(cards(html, "cfact").length, 1);
  assert.equal(cards(html).length, 0, "the fact card replaces the list — never both");
  assert.ok(html.includes("Not measured yet"));
});

test("with no cost history anywhere it says how the history starts", () => {
  const { costScreen } = loadPerfViews();
  assert.ok(costScreen({ sections: [] }, H).includes("no cost history yet"));
});

const heroOf = (html) => html.match(/<div class="card chero[\s\S]*?(?=<div class="card c|$)/)?.[0] || "";

test("the hero is the picked provider's best value alone: model, and score and cost bars against its own ceilings", () => {
  const { costScreen } = loadPerfViews();
  const pts = [point("opus", 9.28, 2.5, { onFrontier: true }), point("fable", 9.5, 10)];
  const data = { sections: [
    section("claude", [srow("opus", 2.5), srow("fable", 10)], { points: pts, best: pts[0], worst: point("haiku", 3, 0.2) }),
    section("ollama", [srow("glm", 1)], { best: point("glm", 8, 1) }),
  ] };
  const hero = heroOf(costScreen(data, H, "claude"));
  assert.ok(hero.includes('data-href="#/perf/model/opus"'));
  assert.ok(hero.includes('<div class="fig">opus</div>'));
  assert.ok(hero.includes("98% of fable's score at 25% of its cost"), "measured against the provider's top scorer");
  assert.match(hero, /bar q"><span style="width:98%">[\s\S]*?<b>9\.3<\/b>/);
  assert.match(hero, /bar c"><span style="width:44%">[\s\S]*?<b>2\.5×<\/b>/);
  assert.ok(!hero.includes("glm"), "another provider never appears in this one's hero");
  assert.ok(!costScreen(data, H, "claude").includes("haiku"), "worst is never drawn");
});

test("a provider without a best says why — ungraded, or graded with no clear best", () => {
  const { costScreen } = loadPerfViews();
  const bare = heroOf(costScreen({ sections: [section("ollama", [srow("glm", 1)])] }, H));
  assert.match(bare, /class="card chero none"[\s\S]*?not graded yet/);
  const thin = heroOf(costScreen({ sections: [section("ollama", [srow("glm", 1)], { points: [point("glm", 8.1, 1, { thin: true })] })] }, H));
  assert.match(thin, /no clear best yet/);
});

test("when the best value is also the top scorer the hero says so, not a 100%-of-itself claim", () => {
  const { costScreen } = loadPerfViews();
  const pts = [point("opus", 9.3, 2.5, { onFrontier: true }), point("sonnet", 8.2, 1)];
  const hero = heroOf(costScreen({ sections: [section("claude", [srow("opus", 2.5)], { points: pts, best: pts[0] })] }, H));
  assert.ok(hero.includes("the top score here, at the lowest cost that reaches it"));
});
