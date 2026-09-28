// One provider per page is a phone constraint — its switcher can only show one at a
// time. A desktop shows them side by side, each still costSection's own markup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPage } from "./helpers/page-harness.mjs";

const srow = (model) => ({ model, mult: 1, band: 1, requests: 5, measuredRequests: 5, weeks: 1, measuredWeeks: 1, thin: false });
const COST = { sections: [
  { provider: "ollama", spread: [srow("glm-5.2:cloud")], points: [], best: null, worst: null },
  { provider: "claude", spread: [srow("claude-sonnet-5")], points: [], best: null, worst: null },
] };

async function costOn(layout) {
  const P = loadPage(layout ? { layout } : {});
  await P.flush();
  P.location.hash = "#/cost";
  P.fireHashchange();
  await P.flush();
  P.respondCost(COST);
  await P.flush();
  return P;
}

test("the desktop Cost screen shows both providers at once, each its own section", async () => {
  const P = await costOn("desktop");
  const grid = P.findByClass("costgrid");
  assert.equal(grid.length, 1, "the sections share one grid");
  assert.equal(P.findByClass("chero", grid[0]).length, 2, "one value hero per provider");
  // Each provider is one grid item: loose cards would flow into a mosaic that mixes providers.
  const cols = P.findByClass("costcol", grid[0]);
  assert.equal(cols.length, 2, "one column per provider");
  for (const col of cols) assert.equal(P.findByClass("chero", col).length, 1, "each column holds its own provider's hero");
});

test("the phone Cost screen still shows one provider, behind its switcher", async () => {
  const P = await costOn();
  assert.equal(P.findByClass("costgrid").length, 0, "the phone is one provider per page");
  assert.equal(P.findByClass("chero").length, 1);
});
