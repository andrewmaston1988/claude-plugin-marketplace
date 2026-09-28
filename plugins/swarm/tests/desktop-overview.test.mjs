import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const point = (model, wtd, multiplier) => ({ model, wtd, multiplier, n: 8, onFrontier: true });
// The payload the hub no longer has any part of — kept whole so a stray read would draw
// a real top-models list rather than crash, and the fetchLog assertion is the one that bites.
const PERF = { grading: true, rows: 20, overall: [], domains: [], aspects: [], views: {
  leaders: [{ aspect: "code", top: [
    { model: "model-alpha", weighted: 8.1, n: 12, provisional: false },
    { model: "model-beta", weighted: 7.3, n: 4, provisional: true },
  ] }],
} };
const COST = { sections: [
  { provider: "ollama", points: [point("model-alpha", 8.1, 1)], spread: [{ model: "model-alpha", mult: 1 }], best: point("model-alpha", 8.1, 1) },
  { provider: "claude", points: [point("model-gamma", 7.6, 2)], spread: [{ model: "model-gamma", mult: 2 }], best: point("model-gamma", 7.6, 2) },
] };
// The run a hub row opens: the run screen's own payload shape, two leaves in two waves.
const runPayload = (name) => ({
  project: "C--code-listproj", name, groupLabel: "list-label",
  startedMs: T - 300_000, finishedMs: T - 60_000, abortedMs: null, stoppedMs: null, quietWarnMs: 60_000,
  totals: { byState: { ok: 1, failed: 1 } },
  tasks: [
    { id: "leaf-a", state: "ok", model: "glm", tokens: { input: 10, output: 20 }, after: [] },
    { id: "leaf-b", state: "failed", model: "gpt-6-luna", tokens: { input: 5, output: 5 }, after: ["leaf-a"] },
  ],
  waves: [["leaf-a"], ["leaf-b"]],
});
const OPENED = "C--code-listproj/DONE_2";
const OPENED_URL = "/api/runs/C--code-listproj/DONE_2";
const isRunUrl = (u) => /^\/api\/runs\/[^/]+\/[^/?]+/.test(u);

// An in-memory localStorage: the same object handed to two boots is the same storage,
// which is what "the state survives a reload" means in a harness with no browser.
function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

function replies({ usage = USAGE, cost = COST, run = null } = {}) {
  const table = [
    [(u) => /^\/api\/runs(\?|$)/.test(u), RUNS],
    [(u) => u === "/api/usage", usage],
    [(u) => u === "/api/cost", cost],
    // Answered, not expected: the hub is claiming it never asks, and that claim is made
    // by its own test against fetchLog — here the read is served so a boot that does ask
    // fails on what it drew rather than on every test dying at the same request.
    [(u) => u.startsWith("/api/perf"), PERF],
  ];
  if (run) table.push([isRunUrl, run]);
  return table;
}

async function settle(P, table = replies(), fail = []) {
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
async function hub({ usage = USAGE, cost = COST, run = null, fail = [], failPerfJs = false, storage } = {}) {
  const P = loadPage({ layout: "desktop", clock: () => T, failPerfJs, storage });
  await settle(P, replies({ usage, cost, run }), fail);
  assert.equal(P.location.hash, "#/overview");
  return P;
}

const overview = () => hub();

async function sourceScreen(P, hash) {
  P.location.hash = hash;
  P.fireHashchange();
  await settle(P, replies({ run: runPayload("DONE_2") }));
}

const markup = (P, cls) => P.findByClass(cls).map(serialize);
const keys = (P, cls) => P.findByClass(cls).map((e) => e.getAttribute("data-key"));
const finishedRows = (P) => P.findByClass("row").filter((e) => e.getAttribute("data-key").startsWith("C--code-listproj/"));
const rowNamed = (P, name) => finishedRows(P).find((e) => e.getAttribute("data-key").endsWith("/" + name));

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
  assert.deepEqual(cards, markup(P, "rcard"), "live cards use the Runs markup");
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

// ── the run opened in place ──────────────────────────────────────────────

test("a finished row opens its run beneath the row, and the hash never moves", async () => {
  const P = await hub({ run: runPayload("DONE_2") });
  assert.equal(rowNamed(P, "DONE_2").getAttribute("data-href"), "", "a hub row does not navigate");
  P.tap(rowNamed(P, "DONE_2"));
  await settle(P, replies({ run: runPayload("DONE_2") }));
  assert.equal(P.location.hash, "#/overview", "expanding a run is not a navigation");
  assert.deepEqual(P.fetchLog.filter(isRunUrl), [OPENED_URL], "the run comes from the run screen's own endpoint");
  const opened = P.findByClass("ovrun");
  assert.equal(opened.length, 1, "the run opens beneath its row");
  const row = rowNamed(P, "DONE_2"), ul = row.parentNode;
  assert.equal(ul.childNodes.indexOf(opened[0]), ul.childNodes.indexOf(row) + 1, "beneath THAT row");
  assert.match(opened[0].textContent, /leaf-a/, "the run's own leaves are drawn");
});

test("the hub expands a run with the run screen's own markup", async () => {
  const P = await hub({ run: runPayload("DONE_2") });
  P.tap(rowNamed(P, "DONE_2"));
  await settle(P, replies({ run: runPayload("DONE_2") }));
  assert.equal(P.findByClass("ovrun").length, 1, "the hub draws the opened run at all");
  const opened = P.findByClass("ovrun")[0];
  const R = loadPage({ layout: "desktop", clock: () => T });
  await settle(R);
  await sourceScreen(R, "#/run/" + OPENED);
  assert.deepEqual(opened.childNodes.map(serialize), R.main.childNodes.map(serialize),
    "the expansion is the run screen's own renderer, never a second one");
});

test("a second click closes the row, and opening another closes the first", async () => {
  const P = await hub({ run: runPayload("DONE_3") });
  P.tap(rowNamed(P, "DONE_2"));
  await settle(P, replies({ run: runPayload("DONE_2") }));
  assert.equal(P.findByClass("ovrun").length, 1);
  P.tap(rowNamed(P, "DONE_3"));
  await settle(P, replies({ run: runPayload("DONE_3") }));
  assert.deepEqual(keys(P, "ovrun"), ["ov:C--code-listproj/DONE_3"], "one row open at a time");
  assert.equal(P.location.hash, "#/overview");
  P.tap(rowNamed(P, "DONE_3"));
  await settle(P, replies({ run: runPayload("DONE_3") }));
  assert.equal(P.findByClass("ovrun").length, 0, "a second click on the same row closes it");
  assert.deepEqual(P.fetchLog.filter(isRunUrl), [OPENED_URL, "/api/runs/C--code-listproj/DONE_3"],
    "closing reads nothing");
});

test("the open row survives the hub's own re-render", async () => {
  const P = await hub({ run: runPayload("DONE_2") });
  P.tap(rowNamed(P, "DONE_2"));
  await settle(P, replies({ run: runPayload("DONE_2") }));
  P.fireSse("runs", "{}");
  await settle(P, replies({ run: runPayload("DONE_2") }));
  assert.equal(P.findByClass("ovrun").length, 1, "the hub's poll re-render keeps the open row");
  assert.deepEqual(P.fetchLog.filter(isRunUrl), [OPENED_URL], "and holds it rather than reading it twice");
});

test("a failed run read closes the row again rather than leaving an empty shelf", async () => {
  const P = await hub({ run: runPayload("DONE_2") });
  P.tap(rowNamed(P, "DONE_2"));
  await settle(P, replies({ run: runPayload("DONE_2") }), [/^\/api\/runs\/C--code-listproj\/DONE_2$/]);
  assert.equal(P.findByClass("ovrun").length, 0);
  assert.equal(P.location.hash, "#/overview");
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
