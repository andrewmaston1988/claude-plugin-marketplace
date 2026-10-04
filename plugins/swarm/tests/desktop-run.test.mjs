// The run screen at desktop width: the verdict, the elapsed time and the token total as
// three boxes across the top, and the leaves as a table grouped by wave. Every cell is a
// value the run payload already carries (D5) — the cut is the layout, never a new figure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadPage, listData, listRow, targetRun, RUN_URL } from "./helpers/page-harness.mjs";

const CSS = readFileSync(new URL("../src/serve/desktop.css", import.meta.url), "utf8");

// A finished leaf and a running one: the two states whose state-and-time cut differs, and
// the two whose latest tool is worth a column.
const TASKS = [
  { id: "survey", state: "ok", model: "glm-5.2:cloud", tokens: { input: 1_200, output: 340 }, durationMs: 125_000, after: [], activity: "Read src/serve/page.html" },
  { id: "impl", state: "running", startedMs: Date.now() - 30_000, lastEventMs: Date.now(), model: "gpt-6-luna", tokens: { input: 800, output: 90 }, after: ["survey"], activity: "Bash node --test", coverage: { status: "incomplete", read: 3, required: 9 } },
];
const RUN = () => ({ ...targetRun(), tasks: TASKS, waves: [["survey"], ["impl"]] });

const isList = (u) => /^\/api\/runs(\?|$)/.test(u);
const isRun = (u) => /^\/api\/runs\/[^/]+\/[^/?]+(\?|$)/.test(u);

// Boot, then land on the run screen. At desktop width a bare load is Overview, so its
// estate read is answered first — the screen under test must own the run's own fetch.
async function runOn(layout) {
  const P = loadPage(layout ? { layout } : {});
  await P.flush();
  P.location.hash = RUN_URL;
  P.fireHashchange();
  await P.flush();
  for (let i = 0; i < 4; i++) {
    const run = P.pendingUrls().find(isRun);
    if (run) { P.respondRun(RUN()); await P.flush(); continue; }
    const list = P.pendingUrls().find(isList);
    if (list) { P.respondList(listData(listRow())); await P.flush(); continue; }
    break;
  }
  return P;
}

const rowOf = (P, id) => P.findByClass("row").find((r) => r.getAttribute("data-node") === id);
const cellsOf = (P, id) => P.findByClass("col", rowOf(P, id)).map((c) => c.textContent);
const graphOf = (P) => P.findByClass("graph")[0];

// ── the three boxes ──────────────────────────────────────────────────────

test("the desktop run screen opens on three boxes: verdict, elapsed, tokens", async () => {
  const desk = await runOn("desktop");
  const stat = desk.findByClass("stat");
  assert.equal(stat.length, 1, "one elapsed box");
  assert.match(stat[0].textContent.trim(), /^0?1:\d\d$/, "the run's own elapsed time");
  assert.equal(desk.findByClass("banner").length, 1, "the verdict keeps its box");
  assert.equal(desk.findByClass("totals").length, 1, "and the token total its own");
});

test("the phone shows no elapsed box — its banner stands alone", async () => {
  const phone = await runOn();
  assert.equal(phone.findByClass("stat").length, 0);
  assert.equal(phone.findByClass("banner").length, 1, "the verdict is the phone's whole summary");
});

test("the elapsed box is the runs table's own figure, not a second computation", () => {
  // One fact, one expression: the runs table's `when` cell and this box are the same call.
  const html = readFileSync(new URL("../src/serve/page.html", import.meta.url), "utf8");
  assert.equal((html.match(/const runElapsed = \(r\) =>/g) || []).length, 1, "defined once");
  assert.ok(html.includes("const elapsed = runElapsed(r);"), "the runs table calls it");
  assert.ok(html.includes("${runElapsed(run)}"), "and so does the run screen's box");
});

// ── the wave-grouped table ───────────────────────────────────────────────

test("the leaves are a table with a header row naming each column", async () => {
  const desk = await runOn("desktop");
  const head = desk.findByClass("rthead");
  assert.equal(head.length, 1);
  assert.deepEqual(head[0].children.map((c) => c.textContent).filter(Boolean),
    ["leaf", "model", "state", "time", "tokens", "latest tool"]);
  assert.equal(desk.findByClass("col", rowOf(desk, "survey")).length, 6, "and one cell per column");
});

// drawRail indexes the list's children against its rows 1:1, so the header has to be the
// list's SIBLING and the rows' own children have to stay put.
test("the header sits above the list without becoming one of its rows", async () => {
  const desk = await runOn("desktop");
  const graph = graphOf(desk);
  const head = desk.findByClass("rthead")[0];
  assert.equal(graph.children[0], head, "the header leads the graph");
  const ul = graph.children.find((c) => c.tagName.toLowerCase() === "ul");
  assert.equal(ul.children.length, 4, "two wave labels and two leaves — the rail's 1:1 index holds");
});

test("the table's cells are the phone row's own values, in the same order", async () => {
  const phone = await runOn();
  const desk = await runOn("desktop");
  assert.equal(phone.findByClass("col", rowOf(phone, "survey")).length, 0, "the phone never passes columns");
  const cells = cellsOf(desk, "survey");
  assert.equal(cells[0], phone.findByClass("name", rowOf(phone, "survey"))[0].textContent, "the leaf's name");
  assert.equal(cells[1], phone.findByClass("meta", rowOf(phone, "survey"))[0].textContent, "its model, the same chip");
  assert.equal(cells[4], phone.findByClass("right", rowOf(phone, "survey"))[0].children[1].textContent, "its token total");
});

// The phone renders `elapsedText ?? state` — one string, one or the other. The table gives
// each its own cell, which is a cut of that string, not a figure either screen lacked.
test("state and time are separate cells, where the phone shows whichever the row has", async () => {
  const desk = await runOn("desktop");
  assert.deepEqual(cellsOf(desk, "survey").slice(2, 4), ["✓ ok", "02:05"], "a finished leaf: state and duration");
  assert.equal(cellsOf(desk, "impl")[2], "◐ running", "a running leaf names its state");
  assert.match(cellsOf(desk, "impl")[3], /^00:3\d$/, "and its elapsed time");

  const phone = await runOn();
  const right = phone.findByClass("right", rowOf(phone, "survey"))[0].textContent;
  assert.match(right, /02:05/);
  assert.doesNotMatch(right, /ok/, "the phone shows the duration alone, never both");
});

test("the latest tool column carries the activity the leaf page already shows", async () => {
  const desk = await runOn("desktop");
  assert.equal(cellsOf(desk, "survey")[5], "Read src/serve/page.html");
  assert.equal(cellsOf(desk, "impl")[5], "Bash node --test");
});

// A short read never fails the leaf, so the row is the only place it reaches the operator.
test("a short read keeps its warning in the table — a mark on the name, the words on hover", async () => {
  const desk = await runOn("desktop");
  const warn = desk.findByClass("covwarn", rowOf(desk, "impl"));
  assert.equal(warn.length, 1, "the desktop row carries the warning");
  assert.equal(warn[0].getAttribute("title"), "read 3 of 9 required entries");
  assert.equal(desk.findByClass("covwarn", rowOf(desk, "survey")).length, 0, "a complete read carries none");
  const phone = await runOn();
  assert.equal(phone.findByClass("covwarn", rowOf(phone, "impl")).length, 1, "the phone row still says it");
});

test("a stalled leaf keeps its tint in the table, where .body has no box to paint", () => {
  assert.ok(CSS.includes(".row.leaf.quiet:has(> .body > .col) { background:var(--warn-bg); }"));
});

test("a leaf row keeps its link to the leaf page — the table replaces no navigation", async () => {
  const desk = await runOn("desktop");
  assert.equal(rowOf(desk, "survey").getAttribute("data-href"), `${RUN_URL}/leaf/survey`);
});

// ── the node screen is not a table ───────────────────────────────────────

test("the node screen keeps the phone's stacked rows — columns are the run screen's", async () => {
  const P = loadPage({ layout: "desktop" });
  await P.flush();
  P.location.hash = `${RUN_URL}/node/impl`;
  P.fireHashchange();
  await P.flush();
  for (let i = 0; i < 4; i++) {
    const run = P.pendingUrls().find(isRun);
    if (run) { P.respondRun(RUN()); await P.flush(); continue; }
    const list = P.pendingUrls().find(isList);
    if (list) { P.respondList(listData(listRow())); await P.flush(); continue; }
    break;
  }
  assert.equal(P.findByClass("col").length, 0, "the subgraph renderer is never passed columns");
  assert.equal(P.findByClass("rthead").length, 0);
});

// ── the stylesheet ───────────────────────────────────────────────────────

test("every run-and-leaf rule sits inside the breakpoint and inside its own markers", () => {
  const from = CSS.indexOf("Run and leaf screens (chunk 2b)");
  const to = CSS.indexOf("/* end run and leaf */");
  assert.ok(from > 0 && to > from, "the section and its closing marker both exist");
  assert.ok(from > CSS.indexOf("@media"), "inside the one breakpoint, not beside it");
  const block = CSS.slice(from, to);
  for (const sel of ["main:has(> .banner):has(> .graph)", "main:has(> .chips.hero)", ".rthead", "--task-cols"])
    assert.ok(block.includes(sel), `${sel} belongs to this chunk`);
  assert.equal(CSS.split("Run and leaf screens (chunk 2b)").length, 2, "one section, not two");
});

// The overlay is absolutely placed in the graph, so the header row pushes it down.
test("the rail overlay starts below the header row", () => {
  assert.match(CSS, /\.graph:has\(> \.rthead\) svg\.overlay \{ top:var\(--rthead\)/);
  assert.match(CSS, /--rthead: 34px/, "one number for the row's height and the overlay's offset");
});

// A bare `color` on the shared `.col` rule wins on specificity and paints every state grey.
test("the table's cells never outrank the leaf's own state colour", () => {
  const rule = CSS.match(/\.row\.leaf \.col \{([^}]*)\}/);
  assert.ok(rule, "the cells carry one base rule");
  assert.doesNotMatch(rule[1], /color:/, "the colour belongs to `.c-<state>` and to the named columns");
});

// Both action-bar buttons size to themselves; an unsized Open digest keeps the phone's
// flex:1 and stretches across the desktop window.
test("the desktop action bar sizes the secondary button like the primary", () => {
  const rule = CSS.split("\n").find((l) => /> \.actionbar [^{]*\.primary/.test(l)) ?? "";
  assert.match(rule, /\.secondary/, rule);
  assert.match(rule, /flex:0 0 auto/, rule);
});
