// The desktop shell: one breakpoint, one nav (the phone's, restyled), and the run
// count the sidebar wears. Every fact asserted here is one the page already holds —
// a desktop width introduces no figure the phone did not have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { loadPage, listData, listRow } from "./helpers/page-harness.mjs";

const SERVE = new URL("../src/serve/", import.meta.url);
const read = (f) => readFileSync(new URL(f, SERVE), "utf8");
const html = read("page.html");
const css = read("desktop.css");
const navOf = (src) => src.match(/<nav id="nav"[^]*?<\/nav>/)[0];

// A breakpoint is a width inside an `@media (...)`, or a `matchMedia` call. A plain
// `min-width:24px` on a flex child is not one — two homes for the real breakpoint is,
// because the JS and the CSS can then disagree about where the line is and only one
// of them is visible in a diff.
const WIDTH = /@media[^{]*(min-width|max-width)\s*:\s*[\d.]+(em|px|rem)|matchMedia/;

test("the breakpoint has exactly one home: desktop.css", () => {
  for (const f of readdirSync(SERVE).filter((n) => /\.(js|mjs|html)$/.test(n))) {
    assert.doesNotMatch(read(f), WIDTH, `${f} names a breakpoint — desktop.css is the one place`);
    assert.doesNotMatch(read(f), /68\.75/, `${f} repeats the breakpoint's number`);
  }
  assert.match(css, /@media \(min-width: 68\.75em\)/, "desktop.css holds the one breakpoint");
  assert.match(css, /--layout:\s*desktop/, "and publishes it as the variable isDesktop() reads");
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
