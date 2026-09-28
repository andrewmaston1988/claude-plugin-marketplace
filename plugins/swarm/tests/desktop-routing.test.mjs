// Decision 3's routes. The layout is read through the harness's --layout stub, so
// these tests drive the same switch the browser does — a second width in the JS would
// pass them and still put the two layouts on different lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPage, listData, listRow } from "./helpers/page-harness.mjs";

async function boot(opts = {}) {
  const P = loadPage(opts);
  await P.flush();
  return P;
}

async function settle(P, data = listData(listRow())) {
  P.respondList(data);
  await P.flush();
  return P;
}

test("a bare load lands on Overview at desktop width, and lights its own tab", async () => {
  const P = await boot({ layout: "desktop" });
  assert.equal(P.location.hash, "#/overview");
  await settle(P);
  assert.equal(P.nav.getAttribute("data-on"), "overview");
  assert.match(P.hdr.textContent, /overview/);
});

test("a bare load is Runs on the phone, and #/ stays Runs on the desktop", async () => {
  const phone = await settle(await boot());
  assert.equal(phone.location.hash, "", "the phone writes no hash it was not asked for");
  assert.equal(phone.nav.getAttribute("data-on"), "runs");

  const desk = await settle(await boot({ layout: "desktop" }));
  desk.location.hash = "#/";
  desk.fireHashchange();
  await settle(desk);
  assert.equal(desk.location.hash, "#/", "#/ is Runs — not a second way to Overview");
  assert.equal(desk.nav.getAttribute("data-on"), "runs");
});

test("a phone bookmarked to #/overview lands on Runs", async () => {
  const P = await settle(await boot());
  P.location.hash = "#/overview";
  P.fireHashchange();
  await P.flush();
  assert.equal(P.location.hash, "#/");
  await settle(P);
  assert.equal(P.nav.getAttribute("data-on"), "runs");
});

test("narrowing the window below the breakpoint leaves #/overview", async () => {
  let wide = true;
  const P = await settle(await boot({ layout: () => (wide ? "desktop" : "phone") }));
  assert.equal(P.location.hash, "#/overview");

  wide = false;
  P.fireResize();
  await P.flush();
  assert.equal(P.location.hash, "#/", "the resize listener redirects too, not only the route");
  await settle(P);
  assert.equal(P.nav.getAttribute("data-on"), "runs");
});

test("Overview refreshes on the SSE runs event, as Runs does", async () => {
  const P = await settle(await boot({ layout: "desktop" }));
  assert.equal(P.nav.getAttribute("data-on"), "overview");
  const before = P.listFetches().length;
  P.fireSse("runs", "{}");
  await P.flush();
  assert.equal(P.listFetches().length, before + 1, "an estate event refetches the estate");
});
