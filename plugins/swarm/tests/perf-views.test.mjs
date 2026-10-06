import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { aggregate, dedupe, overall } from "../src/scores.mjs";
import { OUTCOMES } from "../src/aspects.mjs";
import { coverage, reliability, leaders, rankCells } from "../src/serve/perf-views.mjs";
import { costView } from "../src/cost-view.mjs";
import { loadPerfViews, H } from "./helpers/perf-views-harness.mjs";
import { row, graded, costRow } from "./helpers/perf-rows.mjs";

// ── coverage ────────────────────────────────────────────────────────────────

test("coverage: one cell per model×aspect; n=0 for a model never touched on that aspect", () => {
  const rows = [
    graded({ leaf: "a1", model: "m-a", grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8, code: 8 } }),
    graded({ leaf: "b1", model: "m-b", grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8 } }), // never touches `code`
  ];
  const report = aggregate(rows);
  const { aspects, models, cells } = coverage(report);
  deepEqual(models, ["m-a", "m-b"]);
  ok(aspects.includes("code") && aspects.includes("adherence"));
  const mbCode = cells.find((c) => c.model === "m-b" && c.aspect === "code");
  ok(mbCode, "m-b×code cell must exist even though m-b was never graded on it");
  equal(mbCode.n, 0);
  equal(mbCode.provisional, true, "n=0 is thin evidence too, never treated as solid");
  const maAdherence = cells.find((c) => c.model === "m-a" && c.aspect === "adherence");
  equal(maAdherence.n, 1);
  equal(maAdherence.provisional, true, "n=1 < 5 is provisional");
});

test("coverage: n >= 5 is not provisional", () => {
  const rows = Array.from({ length: 5 }, (_, i) => graded({ leaf: `l${i}`, model: "m-thick" }));
  const { cells } = coverage(aggregate(rows));
  const c = cells.find((x) => x.model === "m-thick" && x.aspect === "adherence");
  equal(c.n, 5);
  equal(c.provisional, false);
});

// ── reliability ─────────────────────────────────────────────────────────────

test("reliability: counts each deduped leaf once, even one graded on two aspects", () => {
  const rows = [
    graded({ leaf: "l1", model: "m-a", grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8, code: 8, impl: 7 } }),
    row({ leaf: "l2", model: "m-a", outcome: "wrong", note: "off-spec", grades: { adherence: 3, handoff: 3, truthfulness: 3, depth: 3 } }),
  ];
  const live = dedupe(rows);
  const result = reliability(live);
  const ma = result.find((r) => r.model === "m-a");
  equal(ma.total, 2, "one leaf graded on two aspects (code, impl) still counts once");
  equal(ma.byOutcome.completed, 1);
  equal(ma.byOutcome.wrong, 1);
  deepEqual(Object.keys(ma.byOutcome), OUTCOMES, "all six outcome buckets present, even at zero");
});

test("reliability: a re-graded leaf (superseded row) is not double counted", () => {
  const first = row({ leaf: "l1", model: "m-a", grades: { adherence: 3, handoff: 3, truthfulness: 3, depth: 3 }, note: "poor" });
  const second = graded({ leaf: "l1", model: "m-a" });
  const live = dedupe([first, second]);
  const result = reliability(live);
  equal(result.find((r) => r.model === "m-a").total, 1);
});

test("reliability: sorted by total descending", () => {
  const rows = [
    ...Array.from({ length: 2 }, (_, i) => graded({ leaf: `a${i}`, model: "m-small" })),
    ...Array.from({ length: 5 }, (_, i) => graded({ leaf: `b${i}`, model: "m-big" })),
  ];
  const result = reliability(dedupe(rows));
  deepEqual(result.map((r) => r.model), ["m-big", "m-small"]);
});

test("reliability: the three infra outcomes collapse into one per-model infra count", () => {
  const rows = [
    graded({ leaf: "ok", model: "m-a" }),
    row({ leaf: "q", model: "m-a", outcome: "quota", note: "dry", grades: undefined }),
    row({ leaf: "r", model: "m-a", outcome: "rate-limited", note: "429", grades: undefined }),
    row({ leaf: "h", model: "m-a", outcome: "harness", note: "lost path", grades: undefined }),
  ];
  const ma = reliability(dedupe(rows)).find((r) => r.model === "m-a");
  equal(ma.infra, 3, "one tally, not three series");
  equal(ma.byOutcome.quota, 1, "the raw counts stay available for audit");
});

// `total` is the GRADED count, and the hero card reads it as "graded" beside a
// completed ratio — so a provider outage must not inflate the denominator.
test("reliability: an infra row is not a graded leaf, so it never lowers the completed ratio", () => {
  const rows = [
    graded({ leaf: "ok", model: "m-a" }),
    row({ leaf: "q", model: "m-a", outcome: "quota", note: "dry", grades: undefined }),
  ];
  const rel = reliability(dedupe(rows));
  const ma = rel.find((r) => r.model === "m-a");
  equal(ma.total, 1, "one graded leaf, however many outages sat beside it");
  equal(ma.infra, 1, "the outage is still counted, just not as a grade");
  equal(ma.byOutcome.quota, 1, "and the raw outcome count stays for audit");
  const html = loadPerfViews().modelSummary(
    { model: "m-a", overall: null, rank: null, aspects: [], reliability: rel, cost: null }, H,
  );
  ok(/<label>graded<\/label><b>1<\/b>/.test(html), html);
  ok(/<label>completed<\/label><b>100%<\/b>/.test(html), `the outage must not read as half a failure — got ${html}`);
});

// The bar is the model's record, not a grade table: infra rides one neutral
// segment so a provider outage never reads as a quality signal.
test("dashboard: reliabilityBars draws infra as one segment, never one per infra outcome", () => {
  const P = loadPerfViews();
  const html = P.reliabilityBars(
    [{ model: "m-a", total: 4, infra: 3, byOutcome: { completed: 1, quota: 2, "rate-limited": 1, harness: 0 } }],
    H,
  );
  const labels = [...html.matchAll(/<span class="chip">.*?<\/i>([^<]*)<\/span>/g)].map((m) => m[1]);
  equal(labels.filter((l) => l === "infra").length, 1, "the legend names infra exactly once");
  deepEqual(labels.filter((l) => l === "quota" || l === "harness" || l === "rate-limited"), [], "the infra outcomes are never legend series");
  equal((html.match(/<span style="flex:/g) || []).length, 2, "one completed segment plus one infra segment");
  ok(html.includes('style="flex:3;'), "the infra segment carries the summed count, not a single outcome's");
});

// ── leaders ─────────────────────────────────────────────────────────────────

test("leaders: ordered by weighted score, capped at k, provisional flagged, outcomes-only model excluded", () => {
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => graded({ leaf: `s${i}`, model: "m-strong", grades: { adherence: 9, handoff: 9, truthfulness: 9, depth: 9 } })),
    ...Array.from({ length: 6 }, (_, i) => graded({ leaf: `w${i}`, model: "m-weak", grades: { adherence: 6, handoff: 6, truthfulness: 6, depth: 6 } })),
    graded({ leaf: "t0", model: "m-thin", grades: { adherence: 3, handoff: 3, truthfulness: 3, depth: 3 } }),
    row({ leaf: "d0", model: "m-dead", outcome: "session-died", note: "died", grades: undefined }),
  ];
  const report = aggregate(rows, { aspect: "adherence" });
  const result = leaders(report, 3);
  equal(result.length, 1);
  const { aspect, top } = result[0];
  equal(aspect, "adherence");
  equal(top.length, 3, "capped at k even though four models have cells");
  deepEqual(top.map((t) => t.model), ["m-strong", "m-weak", "m-thin"], "m-dead has no grade and is excluded");
  ok(top[0].weighted > top[1].weighted, "ordered by weighted score");
  equal(top.find((t) => t.model === "m-thin").provisional, true, "n=1 is provisional");
  equal(top.find((t) => t.model === "m-strong").provisional, false, "n=6 is not provisional");
});

test("leaders: default k=3", () => {
  const rows = Array.from({ length: 4 }, (_, i) => graded({ leaf: `l${i}`, model: `m-${i}` }));
  const report = aggregate(rows, { aspect: "adherence" });
  equal(leaders(report).find((r) => r.aspect === "adherence").top.length, 3);
});

test("leaders: sorts by weighted score itself, independent of the report's own cell order", () => {
  const report = {
    aspects: [
      { aspect: "a", cells: [
        { model: "m-low", weighted: 2, n: 5, provisional: false },
        { model: "m-high", weighted: 9, n: 5, provisional: false },
        { model: "m-mid", weighted: 5, n: 5, provisional: false },
      ] },
    ],
  };
  const { top } = leaders(report, 3).find((r) => r.aspect === "a");
  deepEqual(top.map((t) => t.model), ["m-high", "m-mid", "m-low"], "leaders must not trust the report's own cell order");
});

test("coverage: composite key does not collide when a model or aspect name contains a space", () => {
  const report = {
    aspects: [
      { aspect: "a", cells: [{ model: "b c", n: 3, provisional: false }] },
      { aspect: "a b", cells: [{ model: "c", n: 9, provisional: false }] },
    ],
  };
  const { cells } = coverage(report);
  equal(cells.find((c) => c.aspect === "a" && c.model === "b c").n, 3);
  equal(cells.find((c) => c.aspect === "a b" && c.model === "c").n, 9);
});

test("performance views collapse same-named leaves while cost domains stay provider-local", () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => graded({ leaf: `ollama-${i}`, provider: "ollama", model: "same-model" })),
    ...Array.from({ length: 5 }, (_, i) => graded({ leaf: `codex-${i}`, provider: "codex", model: "same-model" })),
  ];
  const report = aggregate(rows, { aspect: "adherence", combineProviders: true });
  const view = coverage(report);
  equal(view.identities.length, 1);
  equal(view.cells.filter((c) => c.model === "same-model").length, 1);
  deepEqual(view.identities[0].providers, ["codex", "ollama"]);

  const rel = reliability(dedupe(rows));
  equal(rel.length, 1);
  deepEqual(rel[0].providers, ["codex", "ollama"]);

  const cost = costView(rows, [
    costRow("same-model", 1, { provider: "ollama", unit: "meter-points", costDomain: "ollama:meter-points:unpriced" }),
    costRow("same-model", null, { provider: "codex", unit: "usd", classification: "api-equivalent estimate", costDomain: "codex:usd:api-equivalent estimate" }),
  ]);
  equal(cost.points.length, 2);
  equal(cost.points.find((p) => p.provider === "ollama").multiplier, 1);
  equal(cost.points.find((p) => p.provider === "codex").multiplier, null);
  equal(cost.points.find((p) => p.provider === "codex").dominatedBy, null,
    "an incompatible USD estimate cannot dominate or be dominated by meter points");
  equal(cost.spread.find((p) => p.provider === "codex").classification, "api-equivalent estimate");
  deepEqual(cost.sections.map((section) => section.provider), ["codex", "ollama"]);
  equal(cost.best, null, "mixed providers do not produce a misleading global cost pick");
  equal(cost.sections.find((section) => section.provider === "ollama").best.provider, "ollama");
});

// ── the Performance ranking's supersession ──────────────────────────────────
// Operator, 2026-09-26: "Hide, toggle to show" — a superseded model left the
// ranked list, the same rule `swarm models` and the Cost screen already keep.
test("rankCells: a superseded model leaves the ranking until the toggle shows it", () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => graded({ leaf: `old${i}`, provider: "ollama", model: "deepseek-v4-flash:cloud", grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8 } })),
    ...Array.from({ length: 5 }, (_, i) => graded({ leaf: `new${i}`, provider: "ollama", model: "deepseek-v4.1-flash:cloud", grades: { adherence: 9, handoff: 9, truthfulness: 9, depth: 9 } })),
  ];
  const cells = rankCells(overall(rows, { combineProviders: true }).cells);
  deepEqual(cells.filter((c) => !c.supersededBy).map((c) => c.model), ["deepseek-v4.1-flash:cloud"],
    "the default ranking is the visible rows only");
  equal(cells.find((c) => c.model === "deepseek-v4-flash:cloud").supersededBy, "deepseek-v4.1-flash:cloud",
    "the toggle has a row to bring back, and it names what replaced it");
});

// The ranking is a grade record, not a dispatch roster (operator, 2026-09-27:
// "Supersede regardless"): a denylisted superseder still retires its elder.
test("rankCells: a denylisted superseder still supersedes its elder", () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => graded({ leaf: `o${i}`, provider: "ollama", model: "deepseek-v4-flash:cloud", grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8 } })),
    ...Array.from({ length: 5 }, (_, i) => graded({ leaf: `n${i}`, provider: "ollama", model: "deepseek-v4.1-flash:cloud", grades: { adherence: 9, handoff: 9, truthfulness: 9, depth: 9 } })),
  ];
  const cells = rankCells(overall(rows, { combineProviders: true }).cells, { isDenylisted: (m) => m === "deepseek-v4.1-flash:cloud" });
  equal(cells.find((c) => c.model === "deepseek-v4-flash:cloud").supersededBy, "deepseek-v4.1-flash:cloud");
});

test("model detail provider chips carry logos, while model names remain provider-derived", () => {
  const { modelDashboard } = loadPerfViews();
  const html = modelDashboard({ model: "model-x", overall: { providers: ["ollama"] }, aspects: [], coverage: { aspects: [], models: [], cells: [] }, reliability: [], cost: null }, H);
  ok(/class="pchip ollama"><svg[^>]*class="plogo pdisc"[\s\S]*?fill="#fff"[\s\S]*?stroke="#d4d4d4"[\s\S]*?<\/svg>ollama<\/span>/.test(html),
    "the Ollama chip wears Ollama's own disc, not a generic mark");
});

// The chip disc leads the pill, butted to its leading edge, with the provider name
// after it — "(O) ollama". The name text is already there, so the disc is decorative
// and stays aria-hidden.
test("a provider chip leads with the chip disc, flush left of the name", () => {
  const { modelDashboard } = loadPerfViews();
  const html = modelDashboard({ model: "model-x", overall: { providers: ["claude"] }, aspects: [], coverage: { aspects: [], models: [], cells: [] }, reliability: [], cost: null }, H);
  ok(/<span class="pchip claude"><svg[^>]*class="plogo pdisc"[^>]*><circle[^>]*>[\s\S]*?<\/svg>claude<\/span>/.test(html),
    `RED: the chip did not lead with the chip disc — got ${html.slice(html.indexOf("pchip claude"), html.indexOf("pchip claude") + 220)}`);
  ok(/class="plogo pdisc" aria-hidden="true"/.test(html), "the disc is decorative: the name text follows it");
  ok(!/class="plogo pdisc"[^>]*aria-label/.test(html), "the disc does not repeat the name for the screen reader");
});
