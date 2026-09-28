// The desktop shell: one breakpoint, one nav (the phone's, restyled), and the run
// count the sidebar wears. Every fact asserted here is one the page already holds —
// a desktop width introduces no figure the phone did not have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { loadPage, listData, listRow, targetRun, RUN_URL } from "./helpers/page-harness.mjs";

const SERVE = new URL("../src/serve/", import.meta.url);
const read = (f) => readFileSync(new URL(f, SERVE), "utf8");
const html = read("page.html");
const css = read("desktop.css");
const navOf = (src) => src.match(/<nav id="nav"[^]*?<\/nav>/)[0];
// The footer is walked from the nav, not looked up by id: the mini-DOM resolves ids only.
const inNav = (P, cls) => P.findByClass(cls, P.nav)[0] || { textContent: "" };
const textIn = (P, cls) => inNav(P, cls).textContent.trim();

// A breakpoint is a width inside an `@media (...)`, or a `matchMedia` call. A plain
// `min-width:24px` on a flex child is not one — two homes for the real breakpoint is,
// because the JS and the CSS can then disagree about where the line is and only one
// of them is visible in a diff. A raw viewport read is the same breakpoint written a
// third way, in a shape no `@media` grep reaches.
const WIDTH = /@media[^{]*(min-width|max-width)\s*:\s*[\d.]+(em|px|rem)|matchMedia/;
const VIEWPORT = /\b(innerWidth|outerWidth)\b/;

test("the breakpoint has exactly one home: desktop.css", () => {
  const files = readdirSync(SERVE).filter((n) => /\.(js|mjs|html|css)$/.test(n));
  let homes = 0;
  for (const f of files) {
    const src = read(f);
    const n = [...src.matchAll(new RegExp(WIDTH.source, "g"))].length;
    if (f === "desktop.css") { homes += n; continue; }
    assert.equal(n, 0, `${f} names a breakpoint — desktop.css is the one place`);
    assert.doesNotMatch(src, /68\.75/, `${f} repeats the breakpoint's number`);
  }
  assert.equal(homes, 1, "desktop.css declares the breakpoint once, not once per screen");
  assert.match(css, /@media \(min-width: 68\.75em\)/, "desktop.css holds the one breakpoint");
  assert.match(css, /--layout:\s*desktop/, "and publishes it as the variable isDesktop() reads");
  for (const f of files.filter((n) => !/\.css$/.test(n))) {
    assert.doesNotMatch(read(f), VIEWPORT, `${f} compares a raw viewport width — isDesktop() is the one reader`);
  }
});

// Decision 7: hidden, not removed. The phone's bar is still four targets — the link
// exists in the markup and is hidden below the breakpoint, so the desktop sidebar and
// the phone bar are one element, not two that drift.
test("the sidebar is the phone's nav, with Overview hidden below the breakpoint", () => {
  assert.deepEqual([...navOf(html).matchAll(/href="([^"]+)"/g)].map((m) => m[1]),
    ["#/overview", "#/", "#/usage", "#/perf", "#/cost"]);
  const hide = css.indexOf('[data-tab="overview"]');
  assert.ok(hide >= 0, "desktop.css hides the Overview link");
  assert.ok(hide < css.indexOf("@media"), "and hides it by default — the phone keeps four tabs");
});

test("the Runs link wears the estate's run count, not the rows on screen", async () => {
  const P = loadPage({ layout: "desktop" });
  await P.flush();
  // Boot lands on #/overview (Decision 3) and reads the estate. Drain that read first:
  // the harness answers fetches by URL in order, and a superseded build's answer is
  // discarded, so the navigation's own fetch has to be the one left pending.
  P.respondList(listData(listRow()));
  await P.flush();
  P.location.hash = "#/";
  P.fireHashchange();
  await P.flush();
  const done = listRow({ active: false, finishedMs: 1, byState: { ok: 1 } });
  P.respondList({ ...listData(done), finishedTotals: { "C--code-listproj": 7 } });
  await P.flush();
  const count = P.findByClass("navcount", P.nav);
  assert.equal(count.length, 1, "the nav carries one count");
  assert.equal(count[0].textContent.trim(), "7", "the disk total, not the one row rendered");
});

// Decision 2: fr / minmax(<n>ch, 1fr) / clamp() — a raw percentage makes a column
// track its container rather than its content, which is how a table stops lining up.
test("desktop sizing is fr, minmax(nch, 1fr) and clamp — never a raw percentage", () => {
  // A track list is allowed to be one custom property (the Runs table's `--runs-cols`
  // is the single source of its seven tracks), so `var(--x)` is expanded from the
  // file's own declarations — the rule is about the tracks, not about where they sit.
  const decls = new Map([...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2]]));
  const expand = (v) => v.replace(/var\((--[\w-]+)\)/g, (_, n) => decls.get(n) ?? "");
  const grids = [...css.matchAll(/grid-template-columns\s*:\s*([^;]+);/g)].map((m) => expand(m[1]))
    // `subgrid` inherits its tracks from the parent — there is no list here to judge.
    .filter((g) => g.trim() !== "subgrid");
  assert.ok(grids.length, "desktop.css lays its screens out with grid tracks");
  for (const g of grids) {
    assert.match(g, /fr/, `no fr track in: ${g}`);
    assert.doesNotMatch(g, /%/, `a raw percentage track: ${g}`);
  }
  assert.match(css, /clamp\(/, "the sidebar's width is a clamp");
});

// The footer carries two facts and invents none: the socket the page opened and when
// its estate read last landed. A footer that fetched would be a third reader of the
// estate, so the fetch log is part of the assertion, not only the text.
test("the footer names the connection and the last estate read, and fetches nothing for them", async () => {
  assert.match(navOf(html), /class="navfoot"/, "the nav carries the footer");
  const hide = css.indexOf(".navfoot");
  assert.ok(hide >= 0, "desktop.css hides the footer");
  assert.ok(hide < css.indexOf("@media"), "by default — the phone's bar has nowhere to put it");
  assert.match(css.slice(css.indexOf("@media")), /\.bnav \.navfoot\s*\{[^}]*display:/, "and shows it inside the breakpoint");

  const P = loadPage({ layout: "desktop" });
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  // The hub reads three cached payloads behind the estate feed (Chunk 3), and its commit
  // waits on all four. Drain them so the estate read can land; what they hold is the
  // Overview's own tests' business, not this one's.
  for (const url of P.pendingUrls()) P.respond((u) => u === url, {});
  await P.flush();
  const reads = P.fetchLog.length;
  assert.equal(textIn(P, "nf-conn"), "connecting", "the EventSource the page opened, before it opens");
  assert.match(textIn(P, "nf-seen"), /ago$/, "when the estate list landed");
  P.fireEsOpen();
  await P.flush();
  assert.equal(textIn(P, "nf-conn"), "live", "the open socket is what the page shows");
  assert.equal(P.fetchLog.length, reads, "neither fact cost a read");
});

// Only commitView fed the count, so every screen that does not re-route on an estate
// event (Usage, Cost, a run) wore the count frozen at whatever the last commit saw.
test("the sidebar count follows the estate on a screen that does not re-route", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.location.hash = RUN_URL;
  P.fireHashchange();
  await P.flush();
  P.respondRun(targetRun());
  await P.flush();
  assert.equal(textIn(P, "navcount"), "1", "the committed estate's count");
  P.fireSse("runs", "{}");
  await P.flush();
  const lists = P.pendingUrls().filter((u) => /^\/api\/runs(\?|$)/.test(u));
  assert.equal(lists.length, 1, "the estate event takes the read the poll already takes");
  P.respondList({ ...listData(listRow({ active: false, finishedMs: 1 })), finishedTotals: { "C--code-listproj": 9 } });
  await P.flush();
  assert.equal(textIn(P, "navcount"), "9", "the run screen's sidebar is not frozen at the last commit");
});

// Every screen resolves its layout at build time, so a flip has to rebuild it — Cost's
// `isDesktop()` is read once in buildCost and no payload ever moves it.
test("the Cost screen re-routes when the window crosses the breakpoint", async () => {
  const COST = { sections: [
    { provider: "ollama", spread: [{ model: "glm-5.2:cloud", mult: 1, band: 1, requests: 5, measuredRequests: 5, weeks: 1, measuredWeeks: 1, thin: false }], points: [], best: null, worst: null },
    { provider: "claude", spread: [{ model: "claude-sonnet-5", mult: 1, band: 1, requests: 5, measuredRequests: 5, weeks: 1, measuredWeeks: 1, thin: false }], points: [], best: null, worst: null },
  ] };
  let wide = false;
  const P = loadPage({ layout: () => (wide ? "desktop" : "phone") });
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.location.hash = "#/cost";
  P.fireHashchange();
  await P.flush();
  P.respondCost(COST);
  await P.flush();
  assert.equal(P.findByClass("costgrid").length, 0, "the phone is one provider per page");
  wide = true;
  P.fireResize();
  await P.flush();
  assert.equal(P.findByClass("costgrid").length, 1, "the widened window takes the desktop screen");
});

// A failed desktop.js is the one load the page is built to survive, so the rule that
// keeps #/overview from being a dead route cannot live in the asset that failed —
// otherwise the rewrite no-ops and the shell paints an empty main.
test("a failed desktop.js cannot strand #/overview: the rewrite is not the shell's to give", () => {
  const redirect = html.match(/function redirect\(\)[^]*?\n  \}/);
  assert.ok(redirect, "redirect() lives in page.html");
  assert.doesNotMatch(redirect[0], /swarmDesktop/, "a missing shell must not disable the route rewrite");
  assert.doesNotMatch(read("desktop.js"), /resolveHash/, "the rule cannot live in the asset whose absence is the failure");
  assert.match(html, /const resolveHash = \(hash, desktop\)/, "page.html owns it, and page.html always loads");
  const overview = html.match(/async function buildOverview\(\)[^]*?\n  \}/)[0];
  assert.match(overview, /window\.swarmDesktop\.overviewScreen\(/, "the Overview screen has one renderer");
  assert.doesNotMatch(overview, /\?[^\n]*:\s*""/, "and no blank fallback main");
});
