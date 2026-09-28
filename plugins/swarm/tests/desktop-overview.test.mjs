import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPage, listData, listRow, serialize } from "./helpers/page-harness.mjs";

const T = 1_790_000_000_000;
const live = (name) => listRow({ name, startedMs: T - 60_000, mtimeMs: T - 1_000 });
const finished = (name, n) => listRow({
  name, active: false, startedMs: T - (n + 2) * 60_000, mtimeMs: T - n * 60_000,
  finishedMs: T - n * 60_000, byState: { ok: 1 },
});
const RUNS = { ...listData(live("LIVE_A")), runs: [
  live("LIVE_A"), live("LIVE_B"), ...Array.from({ length: 6 }, (_, i) => finished("DONE_" + (i + 1), i + 1)),
] };
const USAGE = { usages: [
  { provider: "anthropic", state: "ok", provenance: "live", limits: [{ kind: "weekly_all", percent: 12 }] },
  { provider: "ollama", state: "ok", provenance: "live", limits: [{ kind: "weekly", percent: 30 }] },
], errors: { codex: "not read" } };
const PERF = { grading: true, rows: 20, overall: [], domains: [], aspects: [], views: {
  leaders: [{ aspect: "code", top: [
    { model: "model-alpha", weighted: 8.1, n: 12, provisional: false },
    { model: "model-beta", weighted: 7.3, n: 4, provisional: true },
  ] }],
} };
const point = (model, wtd, multiplier) => ({ model, wtd, multiplier, n: 8, onFrontier: true });
const COST = { sections: [
  { provider: "ollama", points: [point("model-alpha", 8.1, 1)], spread: [{ model: "model-alpha", mult: 1 }], best: point("model-alpha", 8.1, 1) },
  { provider: "claude", points: [point("model-gamma", 7.6, 2)], spread: [{ model: "model-gamma", mult: 2 }], best: point("model-gamma", 7.6, 2) },
] };
const REPLIES = [
  [(u) => /^\/api\/runs(\?|$)/.test(u), RUNS],
  [(u) => u === "/api/usage", USAGE],
  [(u) => u === "/api/perf", PERF],
  [(u) => u === "/api/cost", COST],
];

async function settle(P, table = REPLIES, fail = []) {
  for (let n = 0; n < 8; n++) {
    await P.flush();
    const urls = P.pendingUrls();
    if (!urls.length) return;
    for (const url of urls) {
      if (fail.some((re) => re.test(url))) { P.fail((u) => u === url); continue; }
      const reply = table.find(([matches]) => matches(url));
      assert.ok(reply, "unexpected request: " + url);
      P.respond((u) => u === url, reply[1]);
    }
  }
  assert.fail("requests did not settle: " + P.pendingUrls().join(", "));
}

// A hub boot: the desktop layout, its own reply table, and the sources a test wants to
// fail. `failPerfJs` boots with no perf.js at all.
async function hub({ usage = USAGE, perf = PERF, cost = COST, fail = [], failPerfJs = false } = {}) {
  const P = loadPage({ layout: "desktop", clock: () => T, failPerfJs });
  const table = [
    [(u) => /^\/api\/runs(\?|$)/.test(u), RUNS],
    [(u) => u === "/api/usage", usage], [(u) => u === "/api/perf", perf], [(u) => u === "/api/cost", cost],
  ];
  await settle(P, table, fail);
  assert.equal(P.location.hash, "#/overview");
  return P;
}

const overview = () => hub();

async function sourceScreen(P, hash) {
  P.location.hash = hash;
  P.fireHashchange();
  await settle(P);
}

const markup = (P, cls) => P.findByClass(cls).map(serialize);
const keys = (P, cls) => P.findByClass(cls).map((e) => e.getAttribute("data-key"));

test("Overview reuses live run cards and caps finished runs at five", async () => {
  const P = await overview();
  assert.equal(P.findByClass("rcard").length, 2, "Overview shows both live runs as cards");
  assert.deepEqual(keys(P, "rcard"), ["C--code-listproj/LIVE_A", "C--code-listproj/LIVE_B"]);
  const done = P.findByClass("row").filter((e) => e.getAttribute("data-href").startsWith("#/run/"));
  assert.equal(done.length, 5, "Overview shows the first five finished runs");
  assert.deepEqual(done.map((e) => e.getAttribute("data-key")),
    Array.from({ length: 5 }, (_, i) => "C--code-listproj/DONE_" + (i + 1)));
  const cards = markup(P, "rcard");
  await sourceScreen(P, "#/");
  assert.deepEqual(cards, markup(P, "rcard"), "live cards use the Runs markup");
});

test("Overview fetches Usage and draws its existing hero and one card per provider", async () => {
  const P = await overview();
  assert.equal(P.findByClass("uhero").length, 1, "Overview draws the Usage hero");
  assert.equal(P.findByClass("upc").length, 3, "two readings and one unread provider");
  assert.deepEqual(P.fetchLog.filter((u) => u === "/api/usage"), ["/api/usage"]);
  assert.match(P.findByClass("uhero")[0].textContent, /MOST LEFT THIS WEEK/);
});

test("Overview fetches Performance and draws the top-models list", async () => {
  const P = await overview();
  assert.equal(P.findByClass("rlist").length, 1, "Overview draws leadersList");
  assert.deepEqual(P.findByClass("rlist")[0].textContent.match(/model-(alpha|beta)/g), ["model-alpha", "model-beta"]);
  assert.deepEqual(P.fetchLog.filter((u) => u.startsWith("/api/perf")), ["/api/perf"],
    "Overview requests the unfiltered Performance payload");
});

test("Overview fetches Cost and draws one best-value hero per provider, without model cards", async () => {
  const P = await overview();
  assert.equal(P.findByClass("chero").length, 2, "one costSection hero per provider");
  assert.equal(P.findByClass("cfact").length, 0, "no costSection fact cards");
  assert.equal(P.findByClass("crow").length, 2, "only the two Performance leaders are model cards");
  assert.deepEqual(P.fetchLog.filter((u) => u === "/api/cost"), ["/api/cost"]);
});

test("Overview's figures are the same markup as their phone source parts", async () => {
  const P = await overview();
  assert.equal(P.findByClass("uhero").length, 1, "Overview has a source Usage hero to compare");
  const overviewHero = markup(P, "uhero");
  const overviewCards = markup(P, "upc");
  const overviewLeaders = markup(P, "crow");
  const overviewCosts = markup(P, "chero");
  const phone = loadPage({ clock: () => T });
  await settle(phone);
  await sourceScreen(phone, "#/usage");
  assert.deepEqual(overviewHero, markup(phone, "uhero"), "the hero keeps Usage's figures");
  assert.deepEqual(overviewCards, markup(phone, "upc"), "provider cards keep Usage's figures");
  await sourceScreen(phone, "#/perf/leaders");
  assert.deepEqual(overviewLeaders, markup(phone, "crow"), "top models keep Performance's figures");
  await sourceScreen(phone, "#/cost/ollama");
  const ollama = markup(phone, "chero")[0];
  await sourceScreen(phone, "#/cost/claude");
  assert.deepEqual(overviewCosts, [ollama, markup(phone, "chero")[0]], "value cards keep Cost's figures");
});

// ── one source down ──────────────────────────────────────────────────────
// The hub reads four sources and its run feed needs none of the other three: a read
// that fails costs its own column, never the screen.

test("Overview keeps the run feed when one source fails, and drops only its column", async () => {
  const P = await hub({ fail: [/^\/api\/usage$/] });
  assert.equal(P.findByClass("rcard").length, 2, "the run feed needs no other source and stays");
  assert.equal(P.findByClass("ovusage").length, 0, "the source that failed draws no column");
  assert.equal(P.findByClass("ovcost").length, 1, "the sources that landed keep theirs");
});

test("Overview draws the run feed alone when /perf.js never loads", async () => {
  const P = await hub({ failPerfJs: true });
  assert.equal(P.findByClass("rcard").length, 2, "the run feed does not come from perf.js");
  const others = ["ovusage", "ovmodels", "ovcost"].map((c) => P.findByClass(c).length);
  assert.deepEqual(others, [0, 0, 0], "no column whose helper bag never arrived");
});

// ── grading off ──────────────────────────────────────────────────────────

test("Overview states why nothing is ranked, as the Performance tab does", async () => {
  const P = await hub({ perf: { grading: false, path: "C:/scores.json" } });
  const models = P.findByClass("ovmodels");
  assert.equal(models.length, 1, "the top-models column keeps its place in the grid");
  assert.match(models[0].textContent, /grading is off/, "the same note the Perf tab draws");
  assert.doesNotMatch(models[0].textContent, /no graded leaves/, "never an empty list blamed on the leaves");
});

// ── no banked cost history ───────────────────────────────────────────────

test("Overview draws Cost's own empty state when nothing is banked", async () => {
  const P = await hub({ cost: { sections: [] } });
  const cost = P.findByClass("ovcost");
  assert.equal(cost.length, 1, "the cost column keeps its grid track");
  assert.match(cost[0].textContent, /no cost history yet/, "the Cost screen's own words for it");
});

// ── the no-new-figures gate ──────────────────────────────────────────────
// Every figure Overview draws must be a named field of the payload its source tab reads,
// and must equal it; a figure with no mapping fails. Each entry names the field, locates
// the figure in the hub, and the census then requires the hub's own digits to be exactly
// what the entries account for — column by column, so an invented number fails even when
// it collides with a figure another column already draws.

// A figure is a run of digits; the glyphs around it are not this test's business (the
// markup-equality test above owns those).
const digits = (text) => String(text).match(/\d+(?:\.\d+)?/g) || [];

function census(root) {
  const out = [];
  (function walk(n) {
    if (n.nodeType === 3) { out.push(...digits(n.nodeValue)); return; }
    if (n.nodeType !== 1) return;
    for (const c of n.childNodes) walk(c);
  })(root);
  return out;
}

// Resolve a tag/class chain under a column, in document order. The mini-DOM has no
// selector engine, and the hub's parts are the source screens' own markup, so a chain
// is what identifies a figure's home.
function pick(root, chain) {
  let level = [root];
  for (const step of chain) {
    const [tag, ...cls] = step.split(".");
    const next = [];
    for (const el of level) for (const c of el.childNodes) {
      if (c.nodeType !== 1 || c.tagName.toLowerCase() !== tag) continue;
      const have = c.getAttribute("class").split(/\s+/);
      if (cls.every((k) => have.includes(k))) next.push(c);
    }
    level = next;
  }
  return level;
}

// The figures at an entry's location: an element's whole text, or one of its own text
// nodes when the element's children carry figures of their own.
const located = (root, e) => pick(root, e.at).map((el) => (e.text == null
  ? el.textContent
  : (el.childNodes.filter((n) => n.nodeType === 3)[e.text] || { nodeValue: "" }).nodeValue));

// A multiset difference a−b: a figure that merely repeats one the column already draws
// still shows up, because the census counts occurrences.
function surplus(actual, expected) {
  const pool = [...expected];
  const extra = [];
  for (const f of actual) { const i = pool.indexOf(f); if (i < 0) extra.push(f); else pool.splice(i, 1); }
  return extra;
}

const LIVE = RUNS.runs.filter((r) => r.active);
const DONE = RUNS.runs.filter((r) => !r.active).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 5);
const usageOf = (p) => USAGE.usages.find((u) => u.provider === p);
const LEAD = PERF.views.leaders[0].top;
const COST_BEST = (p) => COST.sections.find((s) => s.provider === p).best;
// The Cost screen's own unit format, which is what the hero draws the multiplier in.
const mult = (m) => (m >= 10 ? Math.round(m) : Math.round(m * 10) / 10) + "×";
// live.js's own two readings of a timestamp, against the harness's frozen clock.
const elapsed = (ms) => { const s = Math.round((T - ms) / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const ago = (ms) => { const s = Math.round((T - ms) / 1000); return s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

const FIGURES = [
  { col: "ovruns", at: ["div.ovcards", "div.rcard", "div.rh", "span.tm"],
    of: ["/api/runs → runs[].startedMs, read as elapsed time"],
    want: LIVE.map((r) => elapsed(r.startedMs)) },
  { col: "ovruns", at: ["div.ovcards", "div.rcard", "div.rs"], text: 0,
    of: ["/api/runs → runs[].leaves / .waves / .tokens"],
    want: LIVE.map((r) => `${r.leaves} leaves · ${r.waves} wave · ${r.tokens}`) },
  { col: "ovruns", at: ["div.ovcards", "div.rcard", "div.rs", "span.counts"],
    of: ["/api/runs → runs[].byState.running"],
    want: LIVE.map((r) => String(r.byState.running)) },
  { col: "ovruns", at: ["ul", "li.row", "div.body", "div", "span.meta"], text: 0,
    of: ["/api/runs → runs[].mtimeMs, read as age"],
    want: DONE.map((r) => ago(r.mtimeMs)) },
  { col: "ovruns", at: ["ul", "li.row", "div.body", "div", "span.meta", "span.counts"],
    of: ["/api/runs → runs[].byState.ok"],
    want: DONE.map((r) => String(r.byState.ok)) },
  { col: "ovruns", at: ["ul", "li.row", "div.body", "div", "span.meta"], text: 1,
    of: ["/api/runs → runs[].tokens"],
    want: DONE.map((r) => String(r.tokens)) },
  // The identifier slots too: a run or model name may carry digits of its own (`glm-4.6`),
  // and those are the payload's to spell, not the hub's to invent.
  { col: "ovruns", at: ["ul", "li.row", "div.body", "div", "span", "span.name"],
    of: ["/api/runs → runs[].name"],
    want: DONE.map((r) => r.name) },
  { col: "ovruns", at: ["div.ovcards", "div.rcard", "div.rh", "span.nm"],
    of: ["/api/runs → runs[].name"],
    want: LIVE.map((r) => r.name) },
  { col: "ovusage", at: ["div.uhero", "div.fig"],
    of: ["/api/usage → usages[anthropic].limits[].percent, drawn as what is LEFT"],
    want: [`${100 - usageOf("anthropic").limits[0].percent}%`] },
  { col: "ovusage", at: ["div.card.upc", "div.top", "span.val"],
    of: ["/api/usage → usages[].limits[].percent, drawn as what is LEFT"],
    want: [usageOf("anthropic"), usageOf("ollama")].map((u) => `${100 - u.limits[0].percent}%`) },
  { col: "ovusage", at: ["div.card.upc", "div.top", "span.nm"],
    of: ["/api/usage → usages[].provider, and errors' keys for the providers it never read"],
    want: [...USAGE.usages.map((u) => u.provider), ...Object.keys(USAGE.errors)].sort() },
  { col: "ovmodels", at: ["div.rlist", "div.card.crow", "div.top", "span.val"],
    of: ["/api/perf → views.leaders[].top[].weighted"],
    want: LEAD.map((t) => t.weighted.toFixed(2)) },
  { col: "ovmodels", at: ["div.rlist", "div.card.crow", "div.top", "span.who", "span.nm"],
    of: ["/api/perf → views.leaders[].top[].model"],
    want: LEAD.map((t) => t.model) },
  { col: "ovmodels", at: ["div.rlist", "div.card.crow", "div.sub"],
    of: ["/api/perf → views.leaders[].top[].n, and leadersList's own n<5 cutoff"],
    want: LEAD.map((t) => `n=${t.n}${t.provisional ? " · provisional n<5" : ""}`) },
  { col: "ovcost", at: ["div.card.chero", "div.vbar"],
    of: ["/api/cost → sections[].best.wtd and .best.multiplier"],
    want: ["ollama", "claude"].flatMap((p) => [COST_BEST(p).wtd.toFixed(1), mult(COST_BEST(p).multiplier)]) },
  { col: "ovcost", at: ["div.card.chero", "div.fig"],
    of: ["/api/cost → sections[].best.model"],
    want: ["ollama", "claude"].map((p) => COST_BEST(p).model) },
];

test("every figure Overview draws is a field of the payload its tab reads", async () => {
  const P = await hub();
  for (const e of FIGURES) {
    const col = P.findByClass(e.col)[0];
    assert.ok(col, "the hub is missing the " + e.col + " column");
    const got = located(col, e);
    assert.equal(got.length, e.want.length, `${e.of[0]}: ${e.col} draws ${got.length}, its payload names ${e.want.length}`);
    assert.deepEqual(got.map(digits), e.want.map(digits), `${e.of.join(" / ")}: the hub's figures are not its payload's`);
  }
  for (const col of new Set(FIGURES.map((e) => e.col))) {
    const want = FIGURES.filter((e) => e.col === col).flatMap((e) => e.want.flatMap(digits));
    assert.deepEqual(surplus(census(P.findByClass(col)[0]), want), [],
      `the ${col} column draws a figure no field of its payload accounts for`);
  }
});
