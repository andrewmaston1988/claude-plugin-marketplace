// A navigation paints the new screen's frame at once — title, tab, placeholder
// blocks — and the data fills in when it lands; a refresh never blanks the screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPage, listData, listRow } from "./helpers/page-harness.mjs";

const isUsage = (u) => u.startsWith("/api/usage");

async function onRuns() {
  const P = loadPage({ perfViews: { usageScreen: () => `<div class="stub">usage</div>` } });
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  return P;
}

test("a navigation paints its skeleton before the data lands, then swaps it out", async () => {
  const P = await onRuns();
  P.location.hash = "#/usage";
  P.fireHashchange();
  assert.equal(P.findByClass("skeleton").length, 1, "the frame paints in the same turn as the tap");
  assert.equal(P.findByClass("hero").length, 1, "usage's skeleton is shaped like usage");
  assert.match(P.hdr.textContent, /usage/, "the header names the destination at once");
  assert.equal(P.nav.getAttribute("data-on"), "usage");
  await P.flush();
  P.respond(isUsage, { usages: [], errors: {} });
  await P.flush();
  assert.equal(P.findByClass("skeleton").length, 0);
  assert.equal(P.findByClass("stub").length, 1);
});

test("re-routing to the screen already showing never blanks it", async () => {
  const P = await onRuns();
  P.fireHashchange();
  assert.equal(P.findByClass("skeleton").length, 0);
});
