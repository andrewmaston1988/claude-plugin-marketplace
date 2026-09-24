// The Cost screen's renderer, run for real through perf.js (see the harness).
// Mockup 922–983: one provider at a time from a chip row, a note naming that
// provider's unit, then a ranked card per model — or one fact card, never both.
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

test("one chip per provider, the picked one on, the first when nothing is picked", () => {
  const { costScreen } = loadPerfViews();
  const data = { sections: [section("claude", [srow("sonnet", 1)]), section("ollama", [srow("glm", 2)])] };
  const first = costScreen(data, H);
  assert.equal((first.match(/data-cost-provider="/g) || []).length, 2);
  assert.match(first, /class="ctab on" data-cost-provider="claude"/);
  const picked = costScreen(data, H, "ollama");
  assert.match(picked, /class="ctab on" data-cost-provider="ollama"/);
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

test("the note names the provider's unit: meter weight, or a published price against its base", () => {
  const { costScreen } = loadPerfViews();
  const meter = costScreen({ sections: [section("ollama", [srow("glm", 1, { unit: "meter-points" })])] }, H);
  assert.ok(meter.includes("Meter weight"));
  const card = costScreen({ sections: [section("claude", [srow("haiku", 0.5, { unit: "published-price-relative", baseModel: "claude-sonnet-5", asOf: "2026-09-21T00:00:00.000Z" })])] }, H);
  assert.ok(card.includes("Published price relative to claude-sonnet-5") && card.includes("2026-09-21"));
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

test("the hero names each provider's best value — model, score, multiplier — across every provider", () => {
  const { costScreen } = loadPerfViews();
  const html = costScreen({ sections: [
    section("claude", [srow("opus", 2.5)], { best: point("opus", 9.28, 2.5, { onFrontier: true }), worst: point("haiku", 3, 0.2) }),
    section("ollama", [srow("glm", 1)]),
  ] }, H, "claude");
  const hero = html.match(/<div class="uhero chero">[\s\S]*?<\/div><\/div><\/div>/)?.[0] || "";
  assert.match(hero, /BEST VALUE PER PROVIDER/);
  assert.match(hero, /data-href="#\/perf\/model\/opus"[\s\S]*?claude[\s\S]*?opus[\s\S]*?9\.3[\s\S]*?2\.5×/);
  assert.match(hero, /ollama[\s\S]*?not graded yet/, "a provider with no best says so — never the cheapest instead");
  assert.ok(!html.includes("haiku"), "worst is never drawn");
});

test("a graded provider with no best says there is no clear best — not that nothing is graded", () => {
  const { costScreen } = loadPerfViews();
  const html = costScreen({ sections: [section("ollama", [srow("glm", 1)], { points: [point("glm", 8.1, 1, { thin: true })] })] }, H);
  const hero = html.match(/<div class="uhero chero">[\s\S]*?<\/div><\/div><\/div>/)?.[0] || "";
  assert.match(hero, /ollama[\s\S]*?no clear best yet/);
  assert.ok(!hero.includes("not graded yet"));
});
