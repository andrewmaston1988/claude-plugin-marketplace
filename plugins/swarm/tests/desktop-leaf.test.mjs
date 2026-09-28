// The leaf screen at desktop width: the verdict and the chips across the top, the prompt
// and output down the left, the position and token cards beside them. The chips take the
// grid's width — which is the cards' width, never past their right edge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAGE, loadPage, listData, listRow, targetRun, RUN_URL } from "./helpers/page-harness.mjs";

const CSS = readFileSync(new URL("../src/serve/desktop.css", import.meta.url), "utf8");
const LEAF_URL = `${RUN_URL}/leaf/impl`;
const isList = (u) => /^\/api\/runs(\?|$)/.test(u);
const isRun = (u) => /^\/api\/runs\/[^/]+\/[^/?]+(\?|$)/.test(u);
const isLeaf = (u) => /\/leaves\//.test(u);

// A finished leaf with a split to draw: the tokens card only exists when there is one.
const RUN = () => ({
  ...targetRun(),
  tasks: [{ id: "impl", state: "ok", model: "glm", durationMs: 125_000, tokens: { input: 10, cacheCreation: 990, output: 500, cacheRead: 4000 }, after: [] }],
  waves: [["impl"]],
});
const LEAF = { id: "impl", prompt: "do it", output: "done", citations: { checked: 3, drifted: 1, refuted: 0 } };

async function leafOn(layout) {
  const P = loadPage(layout ? { layout } : {});
  await P.flush();
  P.location.hash = LEAF_URL;
  P.fireHashchange();
  await P.flush();
  for (let i = 0; i < 6; i++) {
    const leaf = P.pendingUrls().find(isLeaf);
    if (leaf) { P.respondLeaf(LEAF); await P.flush(); continue; }
    const run = P.pendingUrls().find(isRun);
    if (run) { P.respondRun(RUN()); await P.flush(); continue; }
    const list = P.pendingUrls().find(isList);
    if (list) { P.respondList(listData(listRow())); await P.flush(); continue; }
    break;
  }
  return P;
}

const cssRule = (sel) => {
  const m = CSS.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{([^}]*)\\}"));
  assert.ok(m, `${sel} carries its own rule`);
  return m[1];
};

// ── the screen is the phone's, moved ─────────────────────────────────────

test("the desktop leaf screen is the phone's three cards, word for word", async () => {
  const desk = await leafOn("desktop");
  assert.equal(desk.findByClass("card").length, 3, "position, tokens, prompt/output");
  const phone = await leafOn();
  assert.equal(desk.screenText(), phone.screenText(),
    "placement is the stylesheet's, so the desktop adds no markup and changes no word");
});

test("the leaf screen got its layout from CSS alone — its renderer has no desktop branch", () => {
  const html = readFileSync(PAGE, "utf8");
  const renderer = html.match(/function renderLeafHtml\(run, leaf, id\)[^]*?\n  \}/)[0];
  assert.ok(renderer.length > 500, "the whole renderer was matched");
  assert.doesNotMatch(renderer, /isDesktop|columns|desktop/, "every desktop rule for this screen is in desktop.css");
});

// ── the two-column body ──────────────────────────────────────────────────

test("the leaf body is two columns: the prose left, the figures beside it", () => {
  const g = cssRule("main:has(> .chips.hero)");
  assert.match(g, /grid-template-columns:minmax\(0, 2fr\) minmax\(280px, 1fr\)/);
  assert.match(g, /align-content:start/);
  assert.match(cssRule(":is(main:has(> .chips.hero), .ovleaf) > .card.flush"), /grid-area:3\/1\/5\/2/, "the prompt and output take the left column, across both figure rows");
  // With the last row flexible, an opened prompt or output grows into it and the second
  // figure card holds its place instead of riding down with the prose.
  assert.match(cssRule(":is(main:has(> .chips.hero), .ovleaf)"), /grid-template-rows:auto auto auto 1fr/);
  assert.match(cssRule(":is(main:has(> .chips.hero), .ovleaf) > .card:not(.flush)"), /grid-column:2/, "the position and token cards stack beside it");
});

test("the verdict and the chips span both columns, above the body", () => {
  assert.match(cssRule(":is(main:has(> .chips.hero), .ovleaf) > .banner"), /grid-area:1\/1\/2\/3/);
  assert.match(cssRule(":is(main:has(> .chips.hero), .ovleaf) > .chips.hero"), /grid-area:2\/1\/3\/3/);
});

// The chips wear the grid's width, so they never run past the capped cards' right edge.
test("the chips wear the grid's width, which is the cards' width", () => {
  assert.match(cssRule(":is(main:has(> .chips.hero), .ovleaf) > .chips.hero"), /padding:0/);
  // The rule it corrects is the phone's own, and it stays the phone's.
  assert.match(readFileSync(PAGE, "utf8"), /\.chips\.hero \{ padding:0 16px;/, "the phone keeps its gutter");
});

// The two screens share one renderer, so the layout they ask for is the boundary: the run
// screen's body is runScreen() and both its paint sites pass `isDesktop()`; the node screen
// renders its subgraph through renderRunHtml directly, so nothing there can ask for the cut.
test("only the run screen asks for the table columns, never the node screen", () => {
  const page = readFileSync(PAGE, "utf8");
  const cut = [...page.matchAll(/runScreen\(([^\n]*)\);/g)].map((m) => m[1]);
  assert.equal(cut.length, 3, "the run screen's two paint sites, and the hub's expansion");
  for (const c of cut) assert.match(c, /, isDesktop\(\)$/, "every one of them the run's own cut");
  const bare = [...page.matchAll(/renderRunHtml\((.*?)\);/g)].map((m) => m[1]);
  for (const b of bare.filter((c) => c !== "run, run.tasks, run.waves, columns"))
    assert.match(b, /^(run|currentRun), tasks, waves$/, "the node screen's subgraph, uncut");
});
