// The desktop views reuse the phone's parts, so each phone screen must stay exactly
// its parts joined — a screen that drifts from its parts would split the two layouts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPerfViews, H } from "./helpers/perf-views-harness.mjs";

const V = loadPerfViews();
const h = { ...H, badge: () => "", trophy: (p) => `<i>${p}</i>` };
const lim = (kind, percent) => ({ kind, percent, resetsAt: null, scope: null, window: null });
const USAGE = { usages: [
  { provider: "ollama", state: "ok", provenance: "live", limits: [lim("session", 30), lim("weekly", 60)] },
  { provider: "anthropic", state: "ok", provenance: "live", limits: [lim("session", 10), lim("weekly_all", 5)] },
], errors: { codex: "token expired" } };

test("usageScreen is its tabs, hero and provider cards, in that order", () => {
  for (const w of ["week", "session"]) {
    const p = V.usageParts(USAGE, h, w);
    assert.equal(p.cards.length, 3, "one card per provider named by the read");
    assert.equal(V.usageScreen(USAGE, h, w), p.tabs + p.hero + `<div class="section"><span>providers</span><span class="line"></span></div>` + p.cards.join(""));
  }
  const none = V.usageParts({ usages: [], errors: {} }, h, "week");
  assert.equal(V.usageScreen({ usages: [], errors: {} }, h, "week"), none.tabs + none.empty);
});

const srow = (model, mult) => ({ model, mult, band: 1, requests: 500, measuredRequests: 500, weeks: 3, measuredWeeks: 3, thin: false });
const COST = { sections: [
  { provider: "ollama", spread: [srow("glm", 1), srow("kimi", 3)], points: [], best: null, worst: null },
  { provider: "claude", spread: [srow("sonnet", 2)], points: [], best: null, worst: null },
] };

test("costScreen is the switcher plus the picked provider's costSection", () => {
  for (const [pick, i] of [[undefined, 0], ["claude", 1]]) {
    const screen = V.costScreen(COST, h, pick);
    const section = V.costSection(COST.sections[i], COST, h);
    assert.ok(screen.endsWith(section), `${pick ?? "default"}: the screen ends with its section`);
    assert.match(screen.slice(0, -section.length), /^<div class="seg">[\s\S]*<\/div>$/, "and nothing but the switcher before it");
  }
});

test("modelDashboard is modelSummary followed by coverage and reliability", () => {
  const data = { model: "glm", overall: { combined: 7.5, providers: ["ollama"] }, rank: { position: 2, of: 4 },
    aspects: [{ aspect: "code", cell: { weighted: 7.5, n: 6, provisional: false } }],
    coverage: { aspects: [], models: [], cells: [] }, reliability: [{ model: "glm", total: 6, byOutcome: { completed: 6 } }], cost: null };
  const summary = V.modelSummary(data, h);
  const page = V.modelDashboard(data, h);
  assert.ok(page.startsWith(summary));
  assert.match(page.slice(summary.length), /^<div class="section"><span>coverage<\/span>[\s\S]*<span>reliability<\/span>/);
});
