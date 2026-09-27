// Decision 4: the desktop table is the phone's row cut into its columns, not a second
// renderer. Same text, same order — and the phone never passes `columns`, so its
// markup cannot move with the desktop's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPage, listData, listRow } from "./helpers/page-harness.mjs";

const DONE = listRow({ active: false, finishedMs: 1_700_000_000_000, mtimeMs: 1_700_000_000_000, byState: { ok: 2, failed: 1 }, tokens: 12_000 });
const DATA = { ...listData(DONE), finishedTotals: { "C--code-listproj": 1 } };

// A project's finished stack is collapsed until it is opened (page.html's (d)) — the
// tap is the same on both layouts.
async function runsOn(layout) {
  const P = loadPage(layout ? { layout } : {});
  await P.flush();
  if (layout) {
    // Boot lands on #/overview (Decision 3) and reads the estate. Drain that read
    // before navigating: the harness answers fetches by URL in order, and a
    // superseded build's answer is discarded, so the Runs fetch must be the one left
    // pending when the test answers it.
    P.respondList(DATA);
    await P.flush();
    P.location.hash = "#/";
    P.fireHashchange();
    await P.flush();
  }
  P.respondList(DATA);
  await P.flush();
  P.tap(P.findByClass("section").find((e) => e.getAttribute("data-project")));
  await P.flush();
  P.respondList(DATA);
  await P.flush();
  return P;
}

const rowOf = (P) => P.findByClass("row").find((r) => r.getAttribute("data-href"));

test("the desktop finished stack is a table with a header row naming each column", async () => {
  const P = await runsOn("desktop");
  const head = P.findByClass("rhead");
  assert.equal(head.length, 1, "one header row per project group");
  assert.deepEqual(P.findByClass("col", head[0]).map((c) => c.textContent.trim()), ["project", "when", "state", "tokens"]);
  assert.equal(P.findByClass("col", rowOf(P)).length, 4, "and the row carries one cell per column");
});

test("the table's cells are the phone row's own text, in the same order", async () => {
  const phone = await runsOn();
  const desk = await runsOn("desktop");
  assert.equal(phone.findByClass("col", rowOf(phone)).length, 0, "the phone never passes columns");
  assert.equal(desk.findByClass("col", rowOf(desk)).map((c) => c.textContent).join(" · "),
    phone.findByClass("meta", rowOf(phone))[0].textContent,
    "cut into columns, not re-rendered");
});
