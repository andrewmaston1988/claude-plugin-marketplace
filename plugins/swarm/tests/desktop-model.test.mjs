import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPerfViews, H } from "./helpers/perf-views-harness.mjs";

const data = () => ({
  model: "glm-5.2:cloud",
  overall: { combined: 8.4, providers: ["ollama"] },
  rank: { position: 1, of: 4 },
  aspects: [{ aspect: "adherence", cell: { weighted: 8.6, n: 6, provisional: false } }],
  coverage: { aspects: ["adherence"], models: ["glm-5.2:cloud"], cells: [{ model: "glm-5.2:cloud", aspect: "adherence", n: 6, provisional: false }] },
  reliability: [{ model: "glm-5.2:cloud", total: 10, byOutcome: { completed: 9, timeout: 1 } }],
  cost: { provider: "ollama", multiplier: 1.8, coins: 2, band: 2, measuredRequests: 1232, onFrontier: true, dominatedBy: null, value: "best" },
});

const h = (desktop) => ({ ...H, desktop, badge: (cost) => `<i class="badge">${cost.coins}</i>`, trophy: (place) => `<i class="trophy">${place}</i>` });
const count = (s, re) => (s.match(re) || []).length;

test("desktop model: the medal hero leads aspect, reliability, cost, and readable coverage boxes", () => {
  const html = loadPerfViews().modelDashboard(data(), h(true));
  assert.match(html, /^<div class="model-grid"><div class="model-hero"><div class="card mhero p1">/);
  for (const name of ["model-aspects", "model-reliability", "model-cost", "model-coverage"]) {
    assert.equal(count(html, new RegExp(`class="model-box ${name}"`, "g")), 1, `${name} is its own box`);
  }
  assert.ok(html.indexOf("model-hero") < html.indexOf("model-aspects"));
  assert.ok(html.indexOf("model-aspects") < html.indexOf("model-reliability"));
  assert.ok(html.indexOf("model-reliability") < html.indexOf("model-cost"));
  assert.ok(html.indexOf("model-cost") < html.indexOf("model-coverage"));
  assert.doesNotMatch(html, /<svg[^>]*class="covgrid"/, "desktop model coverage uses the table renderer");
  assert.match(html, /class="cvcell"[^>]*>6<\/span>/);
  assert.match(html, /1\.8×/);
  assert.match(html, /1232 measured requests/);
});

test("desktop model: the cost box uses current figures and omits an estimate or unrendered split", () => {
  const html = loadPerfViews().modelDashboard(data(), h(true));
  const cost = html.slice(html.indexOf('class="model-box model-cost"'), html.indexOf('class="model-box model-coverage"'));
  assert.match(cost, /on the frontier/);
  assert.doesNotMatch(cost, /floor|estimate|weeks|input|output|cache/i);
});

test("phone model: the existing summary and SVG coverage stay in the original composition", () => {
  const model = data();
  const views = loadPerfViews();
  const summary = views.modelSummary(model, h(false));
  const html = views.modelDashboard(model, h(false));
  assert.ok(html.startsWith(summary));
  assert.doesNotMatch(html, /model-grid|model-box/);
  assert.match(html, /<svg viewBox=/);
});

test("desktop model styles stay within the model chunk markers and let each panel fill its grid track", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/serve/desktop.css", import.meta.url)), "utf8");
  const start = css.indexOf("/* ── Model screen (chunk 2b)");
  const end = css.indexOf("/* end model */", start);
  assert.ok(start >= 0 && end > start, "both model markers exist");
  const modelCss = css.slice(start, end);
  assert.match(modelCss, /\.model-grid\s*\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(modelCss, /\.model-hero > \.mhero\s*\{[^}]*max-width:none/);
  assert.match(modelCss, /\.model-coverage\s*\{[^}]*grid-column:1 \/ -1/);
  assert.doesNotMatch(css.slice(0, start) + css.slice(end + "/* end model */".length), /\.model-(?:grid|hero|box|aspects|reliability|cost|coverage)/);
});