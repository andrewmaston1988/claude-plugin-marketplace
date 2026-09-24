import { test } from "node:test";
import assert from "node:assert/strict";
import { listRow, listData, loadPage } from "./helpers/page-harness.mjs";

// A committed view is the destination whole: fields the last screen named (a perf
// `kind`, a cost `which`) must not linger, or every poll of the next screen reads as
// a navigation — skeleton painted, page scrolled to the top, every 5 s.
test("flicker: leaving a screen that names a kind leaves no trace — a re-route of the next screen is a refresh, not a navigation", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.location.hash = "#/perf/rank";
  P.fireHashchange();
  await P.flush();
  P.respondPerf({ grading: true, overall: [], views: {} });
  await P.flush();
  P.location.hash = "#/";
  P.fireHashchange();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  const settled = P.scrolls.length;
  P.fireHashchange();
  await P.flush();
  assert.equal(P.scrolls.length, settled, "the poll's re-route of the runs list does not jump to the top");
  assert.ok(!P.main.innerHTML.includes("skeleton"), "nor paints the skeleton over it");
});
