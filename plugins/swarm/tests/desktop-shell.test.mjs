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

// A width in a media query or a matchMedia call. Two homes for the breakpoint means
// the JS and the CSS can disagree about where the line is, and only one of them is
// visible in a diff.
const WIDTH = /(min-width|max-width)\s*:\s*[\d.]+(em|px|rem)|matchMedia/;

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
  const grids = [...css.matchAll(/grid-template-columns\s*:\s*([^;]+);/g)].map((m) => m[1]);
  assert.ok(grids.length, "desktop.css lays its screens out with grid tracks");
  for (const g of grids) {
    assert.match(g, /fr/, `no fr track in: ${g}`);
    assert.doesNotMatch(g, /%/, `a raw percentage track: ${g}`);
  }
  assert.match(css, /clamp\(/, "the sidebar's width is a clamp");
});
