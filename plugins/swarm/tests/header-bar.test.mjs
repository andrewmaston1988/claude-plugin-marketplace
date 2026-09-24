// Operator 2026-09-24: one header shape on every screen, no back arrow now the bottom
// nav reaches every tab; a child screen carries a tappable trail instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPage, listData, listRow } from "./helpers/page-harness.mjs";

async function goTo(hash) {
  const P = loadPage({ perfViews: { usageScreen: () => `<div class="stub">usage</div>` } });
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  if (hash) { P.location.hash = hash; P.fireHashchange(); }
  return P;
}

test("no screen carries a back button", async () => {
  for (const hash of [null, "#/usage", "#/cost", "#/perf", "#/run/p/r", "#/run/p/r/leaf/a", "#/run/p/r/digest"]) {
    const P = await goTo(hash);
    assert.equal(P.findByClass("btn", P.hdr).length, 0, `back button on ${hash || "runs"}`);
  }
});

test("a tab screen's title is its tab name over a summary", async () => {
  const P = await goTo(null);
  assert.match(P.hdr.textContent, /^swarm\d+ project/);
  assert.equal(P.findByClass("crumb", P.hdr).length, 0);
});

test("a leaf screen trails back through its run to swarm", async () => {
  const P = await goTo("#/run/p/r/leaf/a");
  const crumbs = P.findByClass("crumb", P.hdr);
  assert.deepEqual(crumbs.map((c) => [c.textContent, c.getAttribute("href")]), [["swarm", "#/"], ["r", "#/run/p/r"]]);
  assert.match(P.hdr.textContent, /swarm›r›a/);
});

test("a perf child trails back to Performance", async () => {
  const P = await goTo("#/perf/model/glm");
  assert.deepEqual(P.findByClass("crumb", P.hdr).map((c) => c.getAttribute("href")), ["#/perf"]);
});
