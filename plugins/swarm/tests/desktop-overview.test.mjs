import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { T, finished, RUNS, USAGE, COST, memoryStorage, settle, hub, overview, sourceScreen, markup, keys, finishedRows } from "./helpers/overview-hub.mjs";
import { loadPage } from "./helpers/page-harness.mjs";

test("Overview reuses live run cards and caps finished runs at five", async () => {
  const P = await overview();
  assert.equal(P.findByClass("rcard").length, 2, "Overview shows both live runs as cards");
  assert.deepEqual(keys(P, "rcard"), ["C--code-listproj/LIVE_A", "C--code-listproj/LIVE_B"]);
  const done = finishedRows(P);
  assert.equal(done.length, 5, "Overview shows the first five finished runs");
  assert.deepEqual(done.map((e) => e.getAttribute("data-key")),
    Array.from({ length: 5 }, (_, i) => "C--code-listproj/DONE_" + (i + 1)));
  const cards = markup(P, "rcard");
  await sourceScreen(P, "#/");
  // The one difference is the click: Overview opens a live run beneath its card.
  const runsCards = markup(P, "rcard").map((m) => m.replace(/data-href="#\/run\/([^"]+)"/, 'data-hub="$1"'));
  assert.deepEqual(cards, runsCards, "live cards use the Runs markup, opening in place");
});

// The hub fills #main: the run feed is a direct child of main, at its full width, and
// nothing about it is capped the way a run's own reading column is.
test("Overview's run feed is main's own child, not a column inside a hub grid", async () => {
  const P = await overview();
  const feed = P.findByClass("ovfeed");
  assert.equal(feed.length, 1, "the hub draws one run feed");
  assert.ok(P.main.childNodes.includes(feed[0]), "the feed is a child of main, as the Runs screen's band is");
  assert.equal(P.findByClass("ovgrid").length, 0, "no hub grid narrows the feed into columns");
});

test("Overview's flyout holds Usage and Cost, and nothing from Performance", async () => {
  const P = await overview();
  const panel = P.findByClass("ovpanel");
  assert.equal(panel.length, 1, "the hub draws one flyout panel");
  assert.equal(P.findByClass("uhero").length, 1, "Overview draws the Usage hero");
  assert.equal(P.findByClass("upc").length, 3, "two readings and one unread provider");
  assert.equal(P.findByClass("chero").length, 2, "one costSection hero per provider");
  assert.equal(P.findByClass("cfact").length, 0, "no costSection fact cards");
  assert.equal(P.findByClass("crow").length, 0, "no model card anywhere on the hub");
  assert.equal(P.findByClass("rlist").length, 0, "no top-models list");
  assert.ok(panel[0].contains(P.findByClass("uhero")[0]), "the hero is the flyout's, not the feed's");
  assert.match(P.findByClass("uhero")[0].textContent, /MOST LEFT THIS WEEK/);
  // Each section heads with the way through to its full screen, as the wireframe's box does.
  const links = P.findByClass("phead").map((hd) => hd.childNodes.find((n) => n.tagName === "A")?.getAttribute("href"));
  assert.deepEqual(links, ["#/usage", "#/cost"], "usage links to Usage, best value to Cost");
});

// Grading off is a Performance note, and the hub dropped the column that carried it: the
// string stays in page.html for the Performance tab, and nothing here draws it.
test("the hub draws no top-models column, so no grading note either", async () => {
  const P = await hub();
  assert.equal(P.findByClass("ovmodels").length, 0, "no top-models column");
  assert.doesNotMatch(P.mainText(), /grading is off/, "and none of its column's words");
  assert.deepEqual(P.fetchLog.filter((u) => u.includes("/api/perf")), [],
    "the hub reads no Performance payload at all");
});

test("the flyout toggle closes the panel and the state survives a reload", async () => {
  const store = memoryStorage();
  const P = await hub({ storage: store });
  assert.equal(P.findByClass("ovpanel").length, 1, "the flyout opens by default");
  const btn = P.findByClass("ovtoggle")[0];
  assert.ok(btn, "the hub carries a toggle");
  P.tap(btn);
  await settle(P);
  assert.equal(P.findByClass("ovpanel").length, 0, "the toggle closes the flyout");
  assert.equal(store.getItem("swarm.ovFlyout"), "0", "the closed state is remembered");
  const Q = await hub({ storage: store });
  assert.equal(Q.findByClass("ovpanel").length, 0, "a reload keeps it closed");
  Q.tap(Q.findByClass("ovtoggle")[0]);
  await settle(Q);
  assert.equal(Q.findByClass("ovpanel").length, 1, "and the toggle opens it again");
  assert.equal(store.getItem("swarm.ovFlyout"), "1");
  const R = await hub({ storage: store });
  assert.equal(R.findByClass("ovpanel").length, 1, "a reload keeps it open");
});

test("the hub works without storage: the flyout opens by default", async () => {
  const P = await overview();
  assert.equal(P.findByClass("ovpanel").length, 1);
  P.tap(P.findByClass("ovtoggle")[0]);
  await settle(P);
  assert.equal(P.findByClass("ovpanel").length, 0, "a browser with no localStorage still toggles");
});

// ── the rail ─────────────────────────────────────────────────────────────
// The hub draws no graph, so a finished run's rail carries no lane — but the disc that
// says how the run ended is drawn inside that same svg, and is the only at-a-glance state
// the row has. The stylesheet can collapse the lane; it may not take the disc with it.

test("Overview's finished rows keep the state disc their rail carries", async () => {
  const P = await overview();
  assert.equal(P.findByClass("ovfeed").length, 1, "the hub is missing its run feed");
  const rails = [];
  (function walk(n) {
    if (n.nodeType !== 1) return;
    if (n.tagName.toLowerCase() === "svg" && n.getAttribute("class").split(/\s+/).includes("rail")) rails.push(n);
    for (const c of n.childNodes) walk(c);
  })(P.findByClass("ovfeed")[0]);
  assert.equal(rails.length, 5, "one rail per finished run");
  for (const r of rails) assert.ok(r.childNodes.some((n) => n.tagName.toLowerCase() === "circle"), "the rail still carries its state disc");
});

// The pin above proves the markup; this one proves the stylesheet does not take the disc
// back. A zeroed width did — dot() draws the disc inside the svg the rule sizes, so the
// two leave together — and `preserveAspectRatio="none"` means a narrower width squashes it
// rather than cropping it. The rule may hide the lane line and set nothing else.
test("the hub's rail rule hides the lane, never the box that carries the disc", () => {
  const css = readFileSync(new URL("../src/serve/desktop.css", import.meta.url), "utf8");
  const rules = [...css.matchAll(/\.ovfeed \.row \.rail([^{]*)\{([^}]*)\}/g)]
    .map(([, sel, body]) => ({ sel: sel.trim(), body }));
  assert.ok(rules.length, "desktop.css keeps a rule for the hub's finished-run rail");
  for (const { sel, body } of rules) {
    if (sel) continue;
    assert.doesNotMatch(body, /(^|;)\s*width\s*:/,
      "the rail's own rule sets a width — the svg beneath it carries the state disc, so a zero takes it and a narrow one squashes it");
  }
  assert.ok(rules.some(({ sel, body }) => sel === "path" && /display\s*:\s*none/.test(body)),
    "the rule drops the lane line, which is the only part of the rail the hub has no use for");
});

// The feed fills main and the flyout rides a track of its own beside it — the defect this
// revision fixes was a 1100px hub grid with the feed compressed into a few columns.
test("the hub fills main, and the flyout is a track inside the window", () => {
  const css = readFileSync(new URL("../src/serve/desktop.css", import.meta.url), "utf8");
  const hub = css.slice(css.indexOf("Overview (chunk 3"));
  assert.doesNotMatch(hub, /max-width\s*:\s*1100px/, "the hub is not capped the way a run's reading column is");
  const open = /main:has\(> \.ovfeed\)\s*\{([^}]*)\}/.exec(hub);
  assert.ok(open, "desktop.css lays the hub out");
  assert.match(open[1], /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+clamp\(/,
    "open, the feed takes the width the flyout does not");
  const shut = /main:has\(> \.ovfeed\.shut\)\s*\{([^}]*)\}/.exec(hub);
  assert.ok(shut, "and closed, it says so");
  assert.match(shut[1], /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/,
    "closed, the feed takes the whole width");
});

// ── one source down ──────────────────────────────────────────────────────
// The hub reads three sources and its run feed needs none of the other two: a read
// that fails costs its own section, never the screen.

test("Overview keeps the run feed when one source fails, and drops only its section", async () => {
  const P = await hub({ fail: [/^\/api\/usage$/] });
  assert.equal(P.findByClass("rcard").length, 2, "the run feed needs no other source and stays");
  assert.equal(P.findByClass("ovpanel").length, 1, "the flyout keeps the source that landed");
  assert.equal(P.findByClass("uhero").length, 0, "the source that failed draws no section");
  assert.equal(P.findByClass("chero").length, 2);
});

test("Overview draws the run feed alone when /perf.js never loads", async () => {
  const P = await hub({ failPerfJs: true });
  assert.equal(P.findByClass("rcard").length, 2, "the run feed does not come from perf.js");
  assert.equal(P.findByClass("ovpanel").length, 0, "no panel whose parts never arrived");
  assert.equal(P.findByClass("ovtoggle").length, 0, "and no toggle for a panel that cannot open");
});

// ── no banked cost history ───────────────────────────────────────────────

test("Overview draws Cost's own empty state when nothing is banked", async () => {
  const P = await hub({ cost: { sections: [] } });
  const panel = P.findByClass("ovpanel");
  assert.equal(panel.length, 1, "the flyout keeps its place");
  assert.match(panel[0].textContent, /no cost history yet/, "the Cost screen's own words for it");
});

// ── the no-new-figures gate ──────────────────────────────────────────────
// Every digit the hub draws is a named payload field, counted section by section.

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
const COST_BEST = (p) => COST.sections.find((s) => s.provider === p).best;
// The Cost screen's own unit format, which is what the hero draws the multiplier in.
const mult = (m) => (m >= 10 ? Math.round(m) : Math.round(m * 10) / 10) + "×";
// live.js's own two readings of a timestamp, against the harness's frozen clock.
const elapsed = (ms) => { const s = Math.round((T - ms) / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const ago = (ms) => { const s = Math.round((T - ms) / 1000); return s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

// The feed's own chains carry one wrapper fewer than the Runs screen's: the cards are
// the feed's direct children, because that is what puts them on its grid.
const FIGURES = [
  { col: "ovfeed", at: ["div.rcard", "div.rh", "span.tm"],
    of: ["/api/runs → runs[].startedMs, read as elapsed time"],
    want: LIVE.map((r) => elapsed(r.startedMs)) },
  { col: "ovfeed", at: ["div.rcard", "div.rs"], text: 0,
    of: ["/api/runs → runs[].leaves / .waves / .tokens"],
    want: LIVE.map((r) => `${r.leaves} leaves · ${r.waves} wave · ${r.tokens}`) },
  { col: "ovfeed", at: ["div.rcard", "div.rs", "span.counts"],
    of: ["/api/runs → runs[].byState.running"],
    want: LIVE.map((r) => String(r.byState.running)) },
  { col: "ovfeed", at: ["ul", "li.row", "div.body", "div", "span.meta"], text: 0,
    of: ["/api/runs → runs[].mtimeMs, read as age"],
    want: DONE.map((r) => ago(r.mtimeMs)) },
  { col: "ovfeed", at: ["ul", "li.row", "div.body", "div", "span.meta", "span.counts"],
    of: ["/api/runs → runs[].byState.ok"],
    want: DONE.map((r) => String(r.byState.ok)) },
  { col: "ovfeed", at: ["ul", "li.row", "div.body", "div", "span.meta"], text: 1,
    of: ["/api/runs → runs[].tokens"],
    want: DONE.map((r) => String(r.tokens)) },
  // The identifier slots too: a run or model name may carry digits of its own (`glm-4.6`),
  // and those are the payload's to spell, not the hub's to invent.
  { col: "ovfeed", at: ["ul", "li.row", "div.body", "div", "span", "span.name"],
    of: ["/api/runs → runs[].name"],
    want: DONE.map((r) => r.name) },
  { col: "ovfeed", at: ["div.rcard", "div.rh", "span.nm"],
    of: ["/api/runs → runs[].name"],
    want: LIVE.map((r) => r.name) },
  { col: "ovpanel", at: ["div.uhero", "div.fig"],
    of: ["/api/usage → usages[anthropic].limits[].percent, drawn as what is LEFT"],
    want: [`${100 - usageOf("anthropic").limits[0].percent}%`] },
  { col: "ovpanel", at: ["div.card.upc", "div.top", "span.val"],
    of: ["/api/usage → usages[].limits[].percent, drawn as what is LEFT"],
    want: [usageOf("anthropic"), usageOf("ollama")].map((u) => `${100 - u.limits[0].percent}%`) },
  { col: "ovpanel", at: ["div.card.upc", "div.top", "span.nm"],
    of: ["/api/usage → usages[].provider, and errors' keys for the providers it never read"],
    want: [...USAGE.usages.map((u) => u.provider), ...Object.keys(USAGE.errors)].sort() },
  { col: "ovpanel", at: ["div.card.chero", "div.vbar"],
    of: ["/api/cost → sections[].best.wtd and .best.multiplier"],
    want: ["ollama", "claude"].flatMap((p) => [COST_BEST(p).wtd.toFixed(1), mult(COST_BEST(p).multiplier)]) },
  { col: "ovpanel", at: ["div.card.chero", "div.fig"],
    of: ["/api/cost → sections[].best.model"],
    want: ["ollama", "claude"].map((p) => COST_BEST(p).model) },
];

test("every figure Overview draws is a field of the payload its tab reads", async () => {
  const P = await hub();
  for (const e of FIGURES) {
    const col = P.findByClass(e.col)[0];
    assert.ok(col, "the hub is missing the " + e.col + " source");
    const got = located(col, e);
    assert.equal(got.length, e.want.length, `${e.of[0]}: ${e.col} draws ${got.length}, its payload names ${e.want.length}`);
    assert.deepEqual(got.map(digits), e.want.map(digits), `${e.of.join(" / ")}: the hub's figures are not its payload's`);
  }
  for (const col of new Set(FIGURES.map((e) => e.col))) {
    const want = FIGURES.filter((e) => e.col === col).flatMap((e) => e.want.flatMap(digits));
    assert.deepEqual(surplus(census(P.findByClass(col)[0]), want), [],
      `the ${col} section draws a figure no field of its payload accounts for`);
  }
});

test("Overview's figures are the same markup as their phone source parts", async () => {
  const P = await overview();
  assert.equal(P.findByClass("uhero").length, 1, "Overview has a source Usage hero to compare");
  const overviewHero = markup(P, "uhero");
  const overviewCards = markup(P, "upc");
  const overviewCosts = markup(P, "chero");
  const phone = loadPage({ clock: () => T });
  await settle(phone);
  await sourceScreen(phone, "#/usage");
  assert.deepEqual(overviewHero, markup(phone, "uhero"), "the hero keeps Usage's figures");
  assert.deepEqual(overviewCards, markup(phone, "upc"), "provider cards keep Usage's figures");
  await sourceScreen(phone, "#/cost/ollama");
  const ollama = markup(phone, "chero")[0];
  await sourceScreen(phone, "#/cost/claude");
  assert.deepEqual(overviewCosts, [ollama, markup(phone, "chero")[0]], "value cards keep Cost's figures");
});
