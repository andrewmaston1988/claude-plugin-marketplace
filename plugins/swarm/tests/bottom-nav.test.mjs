// The bottom nav replaces the hamburger menu: four always-visible targets, the
// active one lit from the route, Perf greyed while grading is off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAGE, loadPage, listData, listRow } from "./helpers/page-harness.mjs";

const src = readFileSync(PAGE, "utf8");

test("the nav carries Runs, Usage, Perf and Cost, in that order", () => {
  const nav = src.match(/<nav id="nav"[^]*?<\/nav>/);
  assert.ok(nav, "a #nav element exists in the shell");
  assert.deepEqual([...nav[0].matchAll(/href="([^"]+)"/g)].map((m) => m[1]), ["#/", "#/usage", "#/perf", "#/cost"]);
});

test("the hamburger menu and its disclaimer are gone", () => {
  assert.doesNotMatch(src, /id="menu"|menu-open|menuBtn/);
  assert.doesNotMatch(src, /Reads ~\/.swarm\/runs on the PC/);
});

async function openAt(hash, list = listData(listRow())) {
  const P = loadPage({ perfViews: { usageScreen: () => "<div></div>", costScreen: () => "<div></div>" } });
  await P.flush();
  P.respondList(list);
  await P.flush();
  if (hash) {
    P.location.hash = hash;
    P.fireHashchange();
    await P.flush();
  }
  return P;
}

test("the active tab follows the route — a run screen lights Runs, #/usage lights Usage", async () => {
  const P = await openAt(null);
  assert.equal(P.nav.getAttribute("data-on"), "runs");
  P.location.hash = "#/usage";
  P.fireHashchange();
  await P.flush();
  P.respond((u) => u.startsWith("/api/usage"), { usages: [], errors: {} });
  await P.flush();
  assert.equal(P.nav.getAttribute("data-on"), "usage");
});

test("Perf greys out with grading off, and not with it on", async () => {
  const off = await openAt(null, { ...listData(listRow()), grading: false });
  assert.ok(off.perfTab.classList.contains("off"));
  const on = await openAt(null, { ...listData(listRow()), grading: true });
  assert.ok(!on.perfTab.classList.contains("off"));
});
