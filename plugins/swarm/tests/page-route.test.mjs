import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRun } from "../src/runlog.mjs";
import { buildForEachFixture } from "./fixtures/foreach-fixture.mjs";
// The vm harness and the fixtures every row starts from: page.html's own boot
// machinery, so the rows below read as tests rather than as DOM plumbing.
import { PAGE, RUN_URL, targetRun, listRow, listData, loadPage } from "./helpers/page-harness.mjs";

// ── tests ────────────────────────────────────────────────────────────────
test("Test 1: a superseded list fetch never paints over the run screen (the race)", async () => {
  const P = loadPage();
  await P.flush(); // boot: route() → the /api/runs estate scan is in flight
  assert.equal(P.listFetches().length, 1, "boot issued one list fetch");
  P.location.hash = RUN_URL;
  P.fireHashchange();
  await P.flush();
  assert.equal(P.runFetches().length, 1, "navigation issued one run fetch");
  P.respondRun(targetRun()); // the run fetch resolves first — fast
  await P.flush();
  assert.ok(P.screenText().includes("TARGETRUN"), "step 3: the run screen is painted");
  P.respondList(listData(listRow({ name: "LISTRUN", active: false, finishedMs: Date.now() }))); // the slow estate scan lands late, out of order
  await P.flush();
  assert.ok(P.screenText().includes("TARGETRUN"), "step 5: the stale list must not have painted over the run");
});

test("Test 2: a superseded list build writes no shared state and fires no celebration", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow())); // commits; seenActive records LISTRUN as active
  await P.flush();
  P.fireSse("runs"); await P.flush(); // a refresh fetch goes in flight
  P.location.hash = RUN_URL;
  P.fireHashchange();
  await P.flush();
  P.respondRun(targetRun()); // the run commits
  await P.flush();
  // The stale list now lands: LISTRUN went inactive with a new group label.
  P.respondList(listData(listRow({ active: false, finishedMs: Date.now(), groupLabel: "STALELABEL" })));
  await P.flush();
  assert.equal(P.docTitle(), "swarm", "a superseded build does not celebrate");
  assert.ok(P.screenText().includes("TARGETRUN"), "the run screen is still painted");
  const snap = P.snapshot();
  assert.ok(snap, "test seam present (window.__swarmPage)");
  assert.equal(snap.lastList.runs[0].active, true, "lastList is the committed fetch, not the superseded one");
  assert.equal(snap.seenActive.get("C--code-listproj/LISTRUN"), true, "seenActive still holds the committed scan");
  assert.equal(snap.groupLabels["C--code-listproj"], "list-label", "groupLabels hold the committed labels, not the stale ones");
  assert.equal(snap.currentRun.name, "TARGETRUN", "currentRun is the run from the committed navigation");
});

test("Test 3: a 1 s tick mid-navigation repaints the committed screen, not the pending one", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.location.hash = RUN_URL;
  P.fireHashchange();
  await P.flush();
  P.respondRun(targetRun());
  await P.flush(); // the run screen is committed and painted
  assert.ok(P.screenText().includes("TARGETRUN"));
  P.location.hash = "#/";
  P.fireHashchange();
  await P.flush(); // back to the list — its fetch is slow and still pending
  assert.equal(P.listFetches().length, 2, "the list refetch is in flight");
  const s = P.seam();
  assert.ok(s, "test seam present (window.__swarmPage)");
  s.rerender(); // the 1 s clock fires here, between navigation and commit
  assert.ok(P.screenText().includes("TARGETRUN"), "the tick repainted the run — the screen on the glass, not the pending list");
});

test("Test 4: event-driven routes coalesce; a hashchange is never coalesced away", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush(); // the list is committed, so SSE `runs` events will route
  const before = P.listFetches().length;
  P.fireSse("runs"); P.fireSse("runs"); P.fireSse("runs");
  await P.flush();
  assert.equal(P.listFetches().length - before, 1, "three SSE events, one list fetch");
  P.location.hash = RUN_URL;
  P.fireHashchange();
  await P.flush();
  assert.equal(P.runFetches().length, 1, "navigation issued its own fetch, not dropped by the latch");
  P.respondRun(targetRun());
  await P.flush();
  assert.ok(P.screenText().includes("TARGETRUN"), "the hashchange's target screen committed");
  P.respondList(listData(listRow({ name: "LISTRUN", active: false, finishedMs: Date.now() }))); // the coalesced fetch resolves last
  await P.flush();
  assert.ok(P.screenText().includes("TARGETRUN"), "and its stale build did not repaint");
});

test("Test 6: setHtml/setHeader/setSvg are called only from the commit layer", () => {
  const src = readFileSync(PAGE, "utf8");
  const script = src.match(/<script>([\s\S]*)<\/script>/)[1];
  const code = stripStringsAndComments(script);
  const lines = code.split("\n");
  // Both forms reset attribution: a `function NAME` declaration AND a top-level
  // `const NAME = (...) =>` arrow. Matching only the former was a blind spot: an
  // arrow paint helper written textually after commitView inherited its name and
  // passed while violating the invariant (code review, 2026-09-09).
  // Anchored at the IIFE's own two-space indent, so an inner helper arrow (four spaces
  // or more, like drawRail's `stroke`) does not steal the attribution of its caller.
  const decl = /^ {2}(?:(async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\()/;
  // The function a line sits in: the last `function NAME(` declaration at or
  // above it. (page.html declares functions at IIFE top level only; inner
  // helpers are const arrows, which do not reset the attribution.) A token in
  // a comment or a string literal cannot reach here — the stripper blanks
  // both — so this matches call position, not the token's mere presence.
  const enclosing = new Array(lines.length);
  let cur = null;
  lines.forEach((l, i) => { const m = l.match(decl); if (m) cur = m[2] || m[3]; enclosing[i] = cur; });
  const ALLOWED = { setHtml: ["setHeader", "commitView", "rerender"], setHeader: ["commitView", "rerender"], setSvg: ["drawRail"] };
  for (const [name, allowed] of Object.entries(ALLOWED)) {
    const re = new RegExp(`\\b${name}\\s*\\(`, "g");
    let m;
    while ((m = re.exec(code)) !== null) {
      const lineNo = code.slice(0, m.index).split("\n").length - 1;
      if (lines[lineNo].includes(`function ${name}`)) continue; // the primitive's own definition
      const fn = enclosing[lineNo];
      assert.ok(fn, `${name}( at line ${lineNo + 1} sits outside any function`);
      assert.ok(allowed.includes(fn),
        `${name}( is called in ${fn} (line ${lineNo + 1}); the paint primitive belongs to the commit layer only (${allowed.join(", ")}) — extending ALLOWED is a deliberate edit with a reason`);
    }
  }
});

// Blank the CONTENT of every comment, string, template and regex literal with
// spaces (newlines preserved, so line numbers still resolve), leaving pure
// code. Handles nested template interpolations and regex-vs-division by the
// usual "previous significant character" rule.
function stripStringsAndComments(js) {
  let out = "";
  let i = 0;
  let mode = "code"; // code | interp (inside ${ }) | sq | dq | tpl | re
  let depth = 0; // {} depth inside the innermost interpolation
  let reClass = false; // inside a regex [...] class
  const stack = [];
  let lastCode = "";
  const blank = () => { out += js[i] === "\n" ? "\n" : " "; i++; };
  while (i < js.length) {
    const c = js[i], n = js[i + 1];
    if (mode === "code" || mode === "interp") {
      if (c === "/" && n === "/") { while (i < js.length && js[i] !== "\n") blank(); continue; }
      if (c === "/" && n === "*") { blank(); blank(); while (i < js.length && !(js[i] === "*" && js[i + 1] === "/")) blank(); blank(); blank(); continue; }
      if (c === "'") { stack.push(mode); mode = "sq"; blank(); continue; }
      if (c === '"') { stack.push(mode); mode = "dq"; blank(); continue; }
      if (c === "`") { stack.push(mode); mode = "tpl"; blank(); continue; }
      if (c === "/" && !/[\w$)\]]/.test(lastCode)) { stack.push(mode); mode = "re"; reClass = false; blank(); continue; }
      if (mode === "interp" && c === "{") { depth++; out += c; i++; lastCode = c; continue; }
      if (mode === "interp" && c === "}") {
        if (depth > 0) { depth--; out += c; i++; lastCode = c; continue; }
        mode = stack.pop(); blank(); continue; // close of ${ }
      }
      out += c; i++; if (!/\s/.test(c)) lastCode = c; continue;
    }
    if (mode === "sq" || mode === "dq") {
      const q = mode === "sq" ? "'" : '"';
      if (c === "\\") { blank(); blank(); continue; }
      if (c === q) mode = stack.pop();
      blank(); continue;
    }
    if (mode === "tpl") {
      if (c === "\\") { blank(); blank(); continue; }
      if (c === "`") { mode = stack.pop(); blank(); continue; }
      if (c === "$" && n === "{") { stack.push("tpl"); mode = "interp"; depth = 0; blank(); blank(); continue; }
      blank(); continue;
    }
    // mode === "re"
    if (c === "\\") { blank(); blank(); continue; }
    if (c === "[") { reClass = true; blank(); continue; }
    if (c === "]") { reClass = false; blank(); continue; }
    if (c === "/" && !reClass) { mode = stack.pop(); blank(); while (i < js.length && /[\w$]/.test(js[i])) blank(); continue; }
    blank(); continue;
  }
  return out;
}

// ── cost badges + the leaf chip ──────────────────────────────────────────
// Badge placement is a hard rule: 💲 bands live ONLY on the perf pages and
// the model detail view. Run and leaf rows read a run; they are never
// compared, so a badge there is clutter. These tests fail if a later edit
// scatters badges back onto them.

const allNodes = (el, out = []) => { for (const n of el.childNodes || []) { out.push(n); allNodes(n, out); } return out; };
const badgesIn = (el) => allNodes(el).filter((n) => n.nodeType === 1 && (n.getAttribute("class") || "").split(/\s+/).includes("cbadge"));
const chipHref = (el, href) => allNodes(el).find((n) => n.nodeType === 1 && (n.getAttribute("class") || "").split(/\s+/).includes("chip") && n.getAttribute("data-href") === href);

// A /api/perf payload with one measured model (4.4× → band 2 → 💲💲) and one
// unmeasured tier (band null → the em dash, never a blank that reads as
// dominated).
const perfPayload = () => ({
  grading: true, path: "x", lines: 2, rows: 2, priorWeight: 4,
  aspects: [], universals: ["adherence", "handoff", "truthfulness", "depth"], domains: [],
  filters: { aspect: null, model: null, domain: null },
  overall: [
    { model: "m-dear", combined: 7.9, n: 6, provisional: false, outcomes: { completed: 6 }, wtds: { adherence: 7.9, handoff: 7.9, truthfulness: 7.9, depth: 7.9 } },
    { model: "sonnet", combined: 7.2, n: 2, provisional: true, outcomes: { completed: 2 }, wtds: { adherence: 7.2, handoff: 7.2, truthfulness: 7.2, depth: 7.2 } },
  ],
  report: [],
  views: {
    coverage: { aspects: [], models: [], cells: [] },
    reliability: [],
    leaders: [],
    cost: {
      bands: [2, 5],
      points: [
        { model: "m-dear", wtd: 7.9, n: 6, multiplier: 4.4, band: 2, onFrontier: true, dominatedBy: null, thin: false },
        { model: "sonnet", wtd: 7.2, n: 2, multiplier: null, band: null, onFrontier: false, dominatedBy: null, thin: false },
      ],
      spread: [
        { model: "m-dear", mult: 4.4, band: 2, requests: 300, measuredRequests: 300, weeks: 1, measuredWeeks: 1, thin: false },
        { model: "sonnet", mult: null, band: null, requests: 150, measuredRequests: 0, weeks: 1, measuredWeeks: 0, thin: true },
      ],
    },
  },
});

test("badges: the perf overall list carries the band badge and the unmeasured em dash", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.location.hash = "#/perf";
  P.fireHashchange();
  await P.flush();
  P.respondPerf(perfPayload());
  await P.flush();
  const badges = badgesIn(P.main);
  assert.equal(badges.length, 2, "one badge per ranked row");
  assert.deepEqual(badges.map((b) => b.textContent), ["💲💲", "—"],
    "measured reads its band (💲💲 at 4.4×), unmeasured reads —, never a blank");
});

test("badges: provider-local cost points do not collapse into one ambiguous model badge", async () => {
  const payload = perfPayload();
  payload.overall = [{ model: "same-model", combined: 7.9, n: 6, provisional: false, outcomes: { completed: 6 }, wtds: { adherence: 7.9, handoff: 7.9, truthfulness: 7.9, depth: 7.9 } }];
  payload.views.cost.points = [
    { model: "same-model", provider: "ollama", wtd: 7.9, n: 6, multiplier: 1, band: 1, onFrontier: true, dominatedBy: null, thin: false },
  ];
  payload.views.cost.spread = [
    { model: "same-model", provider: "ollama", mult: 1, band: 1, requests: 300, measuredRequests: 300, weeks: 1, measuredWeeks: 1, thin: false },
    { model: "same-model", provider: "codex", mult: 4, band: 1, requests: 10, measuredRequests: 10, weeks: 1, measuredWeeks: 1, thin: false },
  ];
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.location.hash = "#/perf";
  P.fireHashchange();
  await P.flush();
  P.respondPerf(payload);
  await P.flush();
  const badges = badgesIn(P.main);
  assert.equal(badges.length, 1, "the model still gets the honest unmeasured marker");
  assert.equal(badges[0].textContent, "—", "provider-local alternatives never become a misleading global multiplier");
});

test("badges: run rows and leaf rows carry none — the screen a run is READ on stays clean", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.location.hash = RUN_URL;
  P.fireHashchange();
  await P.flush();
  P.respondRun(targetRun());
  await P.flush();
  assert.ok(P.screenText().includes("TARGETRUN"), "the run screen painted");
  assert.equal(badgesIn(P.main).length + badgesIn(P.hdr).length, 0, "no badge on the run screen");
  assert.ok(!P.screenText().includes("💲"), "no 💲 glyph anywhere on the run screen");
  // The leaf: the model chip is now a link, and it stays PLAIN TEXT — no badge rides it.
  P.location.hash = "#/run/C--code-tgt/TARGETRUN/leaf/leaf-a";
  P.fireHashchange();
  await P.flush();
  P.respondRun(targetRun());
  P.respondLeaf({ id: "leaf-a", model: "glm", ok: true, prompt: "secret prompt", output: "ten bullets" });
  await P.flush();
  const chip = chipHref(P.main, "#/perf/model/glm");
  assert.ok(chip, "the leaf's model chip is clickable, navigating to that model's breakdown");
  assert.equal(chip.textContent, "glm", "the chip stays plain text");
  assert.equal(badgesIn(P.main).length + badgesIn(P.hdr).length, 0, "no badge on the leaf screen");
  assert.ok(!P.screenText().includes("💲"), "no 💲 glyph anywhere on the leaf screen");
});

test("forEach run: one rail dot per session row, none for the forEach label, and no dot strip on it (T14)", async () => {
  // The real server payload: readRun over the manifest-forEach fixture.
  const root = mkdtempSync(join(tmpdir(), "swarm-page-fe-"));
  const dir = join(root, "C--code-tgt", "FERUN");
  let run;
  try { buildForEachFixture(dir); run = JSON.parse(JSON.stringify(readRun(dir))); } finally { rmSync(root, { recursive: true, force: true }); }
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.location.hash = "#/run/C--code-tgt/FERUN";
  P.fireHashchange();
  await P.flush();
  P.respondRun({ ...run, groupLabel: "tgt", abortedMs: null, stoppedMs: null });
  await P.flush();
  const dots = allNodes(P.main).filter((n) => n.nodeType === 1 && n.tagName === "CIRCLE" && !(n.getAttribute("data-key") || "").startsWith("ring:"));
  assert.deepEqual(dots.map((n) => n.getAttribute("data-key")).sort(), [
    "chain[0]~extend", "chain[0]~verify", "chain[0]~walk", "chain[1]~extend", "chain[1]~verify", "chain[1]~walk",
    "chain[2]", "enum", "glossary",
  ], "every session and the unexpanded clone get a dot; the forEach row and expanded containers do not");
  const label = allNodes(P.main).find((n) => n.nodeType === 1 && n.tagName === "LI" && n.getAttribute("data-key") === "chain");
  assert.ok(label, "the forEach row renders");
  assert.ok(/forEach ×3/.test(label.textContent), "it names its clone count");
  assert.equal(allNodes(label).filter((n) => (n.getAttribute?.("class") || "").split(/\s+/).includes("strip")).length, 0, "no dot strip");
  assert.equal(label.getAttribute("data-href"), "#/run/C--code-tgt/FERUN/leaf/chain", "the forEach row taps through to its own leaf screen");
  // a clone session reads `chain[0] walk`: the clone faint, the step plain
  const walk = allNodes(P.main).find((n) => n.nodeType === 1 && n.tagName === "LI" && n.getAttribute("data-key") === "chain[0]~walk");
  const name = allNodes(walk).find((n) => n.nodeType === 1 && (n.getAttribute("class") || "").split(/\s+/).includes("name"));
  const faint = allNodes(name).find((n) => n.nodeType === 1 && (n.getAttribute("class") || "") === "faint");
  assert.equal(faint && faint.textContent, "chain[0]");
  assert.equal(name.textContent, "chain[0] walk");
});

test("cost view: the fifth pill routes, the server's screen draws, and the foot names the config", async () => {
  const P = loadPage({ perfViews: { costScreen: () => `<div class="cost">the cards and the list</div>` } });
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.location.hash = "#/perf/cost";
  P.fireHashchange();
  await P.flush();
  P.respondPerf(perfPayload());
  await P.flush();
  assert.ok(P.screenText().includes("the cards and the list"), "the perf.js widget rendered");
  assert.equal(activeSegLabel(P.main), "cost", "the cost pill is the selected view");
  assert.ok(P.screenText().includes("providers.ollama.cloud.ollama.costBands"), "the foot names the config key");
});

// ── the perf view switcher ────────────────────────────────────────────────
// It lives in page.html (not perf.js), so this harness reaches it through the
// real render path — which is also what makes the cold-load row below possible.
const segTags = (el, tag) => allNodes(el).filter((n) => n.nodeType === 1 && n.tagName === tag);
const segLabels = (el) => segTags(el, "TEXT").filter((n) => (n.getAttribute("class") || "").startsWith("seg-label"));
const activeSegLabel = (el) => {
  const on = segLabels(el).filter((n) => (n.getAttribute("class") || "").split(/\s+/).includes("on"));
  assert.equal(on.length, 1, `exactly one pill must be active, found ${on.length}`);
  return on[0].textContent;
};
const segHits = (el) => segTags(el, "RECT").filter((n) => n.getAttribute("data-href"));
const indicator = (el) => segTags(el, "RECT").find((n) => (n.getAttribute("class") || "") === "seg-ind");
const rail = (el) => segTags(el, "RECT").find((n) => (n.getAttribute("class") || "") === "seg-rail");

const gotoPerf = async (P, hash) => {
  P.location.hash = hash;
  P.fireHashchange();
  await P.flush();
  P.respondPerf(perfPayload());
  await P.flush();
};

test("switcher: one pill per view, exactly one active, and it matches the route", async () => {
  const cases = [["#/perf", "rank"], ["#/perf/coverage", "coverage"], ["#/perf/reliability", "reliability"], ["#/perf/leaders", "leaders"], ["#/perf/cost", "cost"]];
  for (const [hash, label] of cases) {
    const P = loadPage({ perfViews: Object.fromEntries(["coverageGrid", "reliabilityBars", "leadersList", "costScreen"].map((k) => [k, () => "<div></div>"])) });
    await P.flush();
    P.respondList(listData(listRow()));
    await P.flush();
    await gotoPerf(P, hash);
    assert.equal(segLabels(P.main).length, cases.length, `${hash}: one label per view — a dropped view still renders "correctly" otherwise`);
    assert.equal(activeSegLabel(P.main), label, `${hash}: the active pill`);
    const hit = segHits(P.main).find((r) => r.getAttribute("data-href") === hash);
    assert.ok(hit, `${hash}: a transparent hit rect carries the route — a <text> hit area is glyphs only, not a thumb target`);
  }
});

test("switcher: the indicator sits on the active pill, pills tile without overlapping, and nothing is drawn outside the canvas", async () => {
  const geo = async (hash) => {
    const P = loadPage({ perfViews: Object.fromEntries(["coverageGrid", "reliabilityBars", "leadersList", "costScreen"].map((k) => [k, () => "<div></div>"])) });
    await P.flush();
    P.respondList(listData(listRow()));
    await P.flush();
    await gotoPerf(P, hash);
    const hits = segHits(P.main).map((r) => ({ x: Number(r.getAttribute("x")), w: Number(r.getAttribute("width")), href: r.getAttribute("data-href") }));
    const ind = indicator(P.main);
    const tx = Number(/translate\(([-\d.]+)/.exec(ind.getAttribute("transform"))[1]);
    const svg = segTags(P.main, "SVG")[0];
    const vbW = Number(svg.getAttribute("viewBox").split(" ")[2]);
    const r = rail(P.main);
    const railBox = r ? { x: Number(r.getAttribute("x")), w: Number(r.getAttribute("width")), h: Number(r.getAttribute("height")) } : null;
    return { hits, ind: { x: tx, w: Number(ind.getAttribute("width")), h: Number(ind.getAttribute("height")) }, vbW, railBox };
  };
  const rank = await geo("#/perf");
  const pill = (g, href) => g.hits.find((h) => h.href === href);
  assert.deepEqual({ x: rank.ind.x, w: rank.ind.w }, { x: pill(rank, "#/perf").x, w: pill(rank, "#/perf").w }, "the indicator is the active pill's box");
  for (let i = 1; i < rank.hits.length; i++) {
    assert.ok(rank.hits[i].x >= rank.hits[i - 1].x + rank.hits[i - 1].w, `pill ${i} starts at or after pill ${i - 1} ends — no overlap`);
  }
  const last = rank.hits[rank.hits.length - 1];
  assert.ok(rank.vbW >= last.x + last.w, "the viewBox covers the last pill — the one way a scaled layout can still clip");
  // The rail is what makes this read as one control rather than floating labels
  // with a highlight behind them. It shipped missing once; nothing caught it.
  assert.ok(rank.railBox, "a rail rect is drawn");
  const first = rank.hits[0];
  assert.ok(first.x >= rank.railBox.x, "the first pill starts inside the rail, not on its edge");
  assert.ok(last.x + last.w <= rank.railBox.x + rank.railBox.w, "and the last pill ends inside it");
  // HEIGHT, not width: an indicator's width is one pill's and is always narrower
  // than the track, so a width comparison passes even when the indicator fills
  // the rail top-to-bottom and the track disappears behind it.
  assert.ok(rank.ind.h < rank.railBox.h, `the indicator is inset within the rail (${rank.ind.h} < ${rank.railBox.h}), never the full track height`);
  // The moving part: an indicator rendered at a constant x looks right on the
  // default view and wrong on every other one.
  const cost = await geo("#/perf/cost");
  assert.notEqual(cost.ind.x, rank.ind.x, "the indicator moves with the active view");
  assert.deepEqual({ x: cost.ind.x, w: cost.ind.w }, { x: pill(cost, "#/perf/cost").x, w: pill(cost, "#/perf/cost").w }, "…onto the cost pill's box");
});

test("switcher: renders on a COLD #/perf load with window.perfViews never stubbed", async () => {
  // The blocker this guards: perf.js is loaded by loadPerfJs() on the four new
  // views and the model page only. A switcher built there would be undefined on
  // the rank and aspect routes. The old seam ("perf.js is never loaded here;
  // stub the contract") is exactly what hid that, so this row stubs nothing.
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  await gotoPerf(P, "#/perf");
  assert.equal(segLabels(P.main).length, 5, "the switcher rendered without perf.js being loaded at all");
  assert.equal(activeSegLabel(P.main), "rank");
});

// Events arriving faster than /api/runs answers must still paint. With only a
// microtask coalesce, each event started its own fetch; every response landed
// already superseded, routeGuard discarded it, and the list never repainted.
// Drives it with "runs" (a snapshot-version broadcast), not "run" — P3 drops
// the list view's reaction to per-run events entirely, so "runs" is the only
// event left that can still starve the list under a fast burst.
test("Test 9: SSE events faster than the list answers still commit fresh data, one fetch at a time", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  for (let i = 0; i < 4; i++) {
    P.fireSse("runs"); await P.flush();
    P.fireSse("runs"); await P.flush();
    assert.ok(P.pendingCount() <= 1, `never more than one list fetch in flight (iteration ${i})`);
    P.respondList(listData(listRow({ name: `FRESH${i}` })));
    await P.flush();
  }
  assert.ok(/FRESH\d/.test(P.screenText()), "a response from the burst committed");
});

// D3's page half: the list view no longer refetches on every per-run `run`
// event (root cause item 1 — that is what starved the page under live runs).
// It refreshes on `runs` only, the snapshot-changed broadcast.
test("P3: the list view ignores `run` events and refreshes on `runs` only", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  const before = P.listFetches().length;
  P.fireSse("run"); await P.flush();
  assert.equal(P.listFetches().length, before, "a per-run `run` event starts no list fetch on the list view");
  P.fireSse("runs"); await P.flush();
  assert.equal(P.listFetches().length, before + 1, "a `runs` event starts exactly one list fetch");
});

// D6: reconnect on a fatal CLOSE only — the browser's own retry already covers
// CONNECTING — with backoff, and a catch-up list fetch once the new connection
// opens, so events missed during the gap are not silently lost.
test("P4: EventSource reconnect — CLOSED backs off and reconnects, CONNECTING is left alone, open triggers a catch-up refresh", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();

  // A CONNECTING-state error is the browser's own retry in progress — connect()
  // must not double up on top of it.
  const esBefore = P.esCount();
  P.fireEsError(0 /* CONNECTING */);
  await P.flush();
  assert.equal(P.esCount(), esBefore, "no reconnect scheduled while the browser is already retrying");

  // A CLOSED error is fatal — the browser has given up. connect() closes,
  // schedules one reconnect after reconnectDelay(0) = 1000ms, and does so once.
  P.fireEsError(2 /* CLOSED */);
  await P.flush();
  assert.equal(P.esCount(), esBefore, "no new EventSource until the backoff timer fires");
  P.fireTimers(1000);
  await P.flush();
  assert.equal(P.esCount(), esBefore + 1, "exactly one reconnect after reconnectDelay(0)");

  // The next `open` on the new connection is the catch-up: a fresh list fetch,
  // covering whatever `runs`/`run` events were missed during the gap.
  const before = P.listFetches().length;
  P.fireEsOpen();
  await P.flush();
  assert.equal(P.listFetches().length, before + 1, "the reconnect's open triggers one catch-up list fetch");
});

// ── the buzz ─────────────────────────────────────────────────────────────
// The haptic marks "something just finished" — not "you navigated back and I
// noticed". The scan used to live inside buildRuns(), which only ever runs on the
// runs route, so seenActive froze for as long as you sat on any other screen and
// the celebration arrived attached to the navigation that ended the freeze.
//
// Observed two ways, both without a browser: the document title (:277's existing
// instrument) and the haptic — navigator.vibrate is a harness stub, and a stub is
// the only celebration counter there is, since two celebrations of the same run
// write the same title. The device-level haptic stays the manual row.

const endedRow = () => listRow({ active: false, finishedMs: Date.now() });
const mountRun = async (P) => {
  P.location.hash = RUN_URL;
  P.fireHashchange();
  await P.flush();
  P.respondRun(targetRun());
  await P.flush();
};

test("finish: a run going inactive buzzes from the RUN view, where you are sitting", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow())); // boot commits LISTRUN as active
  await P.flush();
  await mountRun(P);
  assert.ok(P.screenText().includes("TARGETRUN"), "the run view is mounted");
  assert.equal(P.vibrations().length, 0, "nothing has finished yet");
  P.fireTimers(5000);
  await P.flush();
  assert.equal(P.listFetches().length, 2,
    "the estate tick reaches a run view — the poll alone refetches this run's own route, which can never see another run finish");
  P.respondList(listData(endedRow()));
  await P.flush();
  assert.equal(P.docTitle(), "✓ LISTRUN", "the buzz lands here, at the finish");
  assert.equal(P.vibrations().length, 1, "one haptic");
});

test("finish: the same finish buzzes from a LEAF view", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.location.hash = "#/run/C--code-tgt/TARGETRUN/leaf/leaf-a";
  P.fireHashchange();
  await P.flush();
  P.respondRun(targetRun());
  P.respondLeaf({ id: "leaf-a", model: "glm", ok: true, prompt: "p", output: "o" });
  await P.flush();
  assert.ok(P.screenText().includes("leaf-a"), "the leaf view is mounted");
  P.fireTimers(5000);
  await P.flush();
  assert.equal(P.listFetches().length, 2, "the estate tick reaches a leaf view too");
  P.respondList(listData(endedRow()));
  await P.flush();
  assert.equal(P.docTitle(), "✓ LISTRUN");
  assert.equal(P.vibrations().length, 1);
});

test("finish: the first load stays silent — absent is not 'was active'", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(endedRow())); // seenActive is empty; this run ended before the page opened
  await P.flush();
  assert.equal(P.docTitle(), "swarm", "history is not news");
  assert.equal(P.vibrations().length, 0, "no haptic for a run that finished before the dashboard opened");
  P.fireTimers(5000);
  await P.flush();
  P.respondList(listData(endedRow()));
  await P.flush();
  assert.equal(P.vibrations().length, 0, "nor on the tick after it");
});

test("finish: the 1 s clock does not fire the buzz — only a fetched transition does", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.fireTimers(1000); P.fireTimers(1000); P.fireTimers(1000); // the clock, between polls
  await P.flush();
  assert.equal(P.listFetches().length, 1, "the clock repaints the same fetched data and fetches nothing");
  assert.equal(P.vibrations().length, 0, "so it cannot fire a buzz");
  P.fireTimers(5000);
  await P.flush();
  P.respondList(listData(endedRow()));
  await P.flush();
  assert.equal(P.vibrations().length, 1, "the fetched transition does");
});

test("finish: one transition celebrates exactly once — the tick and the list build cannot both fire it", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.fireTimers(5000); // one poll: the tick's fetch, then the runs route's own build
  await P.flush();
  assert.equal(P.listFetches().length, 3, "both a tick fetch and a route build are in flight");
  const ended = listData(endedRow());
  P.respondList(ended); // the tick resolves first
  await P.flush();
  assert.equal(P.vibrations().length, 1, "the tick announced the finish");
  P.respondList(ended); // then the route build commits the same transition
  await P.flush();
  assert.equal(P.vibrations().length, 1, "the build must not announce it a second time");
});

test("finish: a run that goes inactive, active again, then inactive again re-arms", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  await mountRun(P); // off the runs route, so each tick's list fetch is unambiguous
  const tick = async (row) => {
    const before = P.listFetches().length;
    P.fireTimers(5000);
    await P.flush();
    assert.equal(P.listFetches().length, before + 1, "each tick fetches the estate, from whatever view is mounted");
    P.respondList(listData(row));
    await P.flush();
  };
  await tick(endedRow());
  assert.equal(P.vibrations().length, 1, "the finish");
  await tick(listRow());
  assert.equal(P.vibrations().length, 1, "active again is not a finish");
  await tick(endedRow());
  assert.equal(P.vibrations().length, 2, "and the second finish fires again — the map tracks the current flag, not a one-way finished set");
});

test("Test 10: a hung list request times out into the error panel and frees the next refresh", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.fireSse("runs"); await P.flush();
  assert.equal(P.pendingCount(), 1, "the refresh is in flight");
  P.fireTimers(20000); await P.flush();
  assert.ok(/timed out/.test(P.screenText()), "the error panel names the timeout");
  const before = P.listFetches().length;
  P.fireSse("runs"); await P.flush();
  assert.equal(P.listFetches().length - before, 1, "the next event starts a new fetch");
});
