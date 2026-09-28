import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { T, finished, RUNS, runPayload, OPENED, OPENED_URL, isRunUrl, replies, settle, hub, rowNamed, sourceScreen, keys } from "./helpers/overview-hub.mjs";
import { loadPage, serialize } from "./helpers/page-harness.mjs";

// ── the run opened in place ──────────────────────────────────────────────

test("a finished row opens its run beneath the row, and the hash never moves", async () => {
  const P = await hub({ run: runPayload("DONE_2") });
  assert.equal(rowNamed(P, "DONE_2").getAttribute("data-href"), "", "a hub row does not navigate");
  P.tap(rowNamed(P, "DONE_2"));
  await settle(P, replies({ run: runPayload("DONE_2") }));
  assert.equal(P.location.hash, "#/overview", "expanding a run is not a navigation");
  assert.deepEqual(P.fetchLog.filter(isRunUrl), [OPENED_URL], "the run comes from the run screen's own endpoint");
  const opened = P.findByClass("ovrun");
  assert.equal(opened.length, 1, "the run opens beneath its row");
  const row = rowNamed(P, "DONE_2"), ul = row.parentNode;
  assert.equal(ul.childNodes.indexOf(opened[0]), ul.childNodes.indexOf(row) + 1, "beneath THAT row");
  assert.match(opened[0].textContent, /leaf-a/, "the run's own leaves are drawn");
});

test("the hub expands a run with the run screen's own markup", async () => {
  const P = await hub({ run: runPayload("DONE_2") });
  P.tap(rowNamed(P, "DONE_2"));
  await settle(P, replies({ run: runPayload("DONE_2") }));
  assert.equal(P.findByClass("ovrun").length, 1, "the hub draws the opened run at all");
  const opened = P.findByClass("ovrun")[0];
  const R = loadPage({ layout: "desktop", clock: () => T });
  await settle(R);
  await sourceScreen(R, "#/run/" + OPENED);
  assert.deepEqual(opened.childNodes.map(serialize), R.main.childNodes.map(serialize),
    "the expansion is the run screen's own renderer, never a second one");
});

test("a second click closes the row, and opening another closes the first", async () => {
  const P = await hub({ run: runPayload("DONE_3") });
  P.tap(rowNamed(P, "DONE_2"));
  await settle(P, replies({ run: runPayload("DONE_2") }));
  assert.equal(P.findByClass("ovrun").length, 1);
  P.tap(rowNamed(P, "DONE_3"));
  await settle(P, replies({ run: runPayload("DONE_3") }));
  assert.deepEqual(keys(P, "ovrun"), ["ov:C--code-listproj/DONE_3"], "one row open at a time");
  assert.equal(P.location.hash, "#/overview");
  P.tap(rowNamed(P, "DONE_3"));
  await settle(P, replies({ run: runPayload("DONE_3") }));
  assert.equal(P.findByClass("ovrun").length, 0, "a second click on the same row closes it");
  assert.deepEqual(P.fetchLog.filter(isRunUrl), [OPENED_URL, "/api/runs/C--code-listproj/DONE_3"],
    "closing reads nothing");
});

test("the open row survives the hub's own re-render", async () => {
  const P = await hub({ run: runPayload("DONE_2") });
  P.tap(rowNamed(P, "DONE_2"));
  await settle(P, replies({ run: runPayload("DONE_2") }));
  P.fireSse("runs", "{}");
  await settle(P, replies({ run: runPayload("DONE_2") }));
  assert.equal(P.findByClass("ovrun").length, 1, "the hub's poll re-render keeps the open row");
  assert.deepEqual(P.fetchLog.filter(isRunUrl), [OPENED_URL], "and holds it rather than reading it twice");
});

test("a failed run read closes the row again rather than leaving an empty shelf", async () => {
  const P = await hub({ run: runPayload("DONE_2") });
  P.tap(rowNamed(P, "DONE_2"));
  await settle(P, replies({ run: runPayload("DONE_2") }), [/^\/api\/runs\/C--code-listproj\/DONE_2$/]);
  assert.equal(P.findByClass("ovrun").length, 0);
  assert.equal(P.location.hash, "#/overview");
});

// A project directory may carry `&` (`C:\code\R&D`); the row's key reaches the page
// escaped in the attribute and decoded in the click, and both must name the same run.
test("a finished row whose project carries & opens beneath its row", async () => {
  const amp = { ...finished("AMP", 1), project: "C--code-R&D", group: "C--code-R&D" };
  const runs = { ...RUNS, runs: [amp] };
  const opened = { ...runPayload("AMP"), project: "C--code-R&D" };
  const table = [[(u) => /^\/api\/runs(\?|$)/.test(u), runs], ...replies({ run: opened }).slice(1)];
  const P = loadPage({ layout: "desktop", clock: () => T });
  await settle(P, table);
  const row = P.findByClass("row").find((e) => e.getAttribute("data-hub"));
  // The harness keeps attributes as written; a browser hands dataset the decoded value.
  row.dataset.hub = row.getAttribute("data-hub").replace(/&amp;/g, "&");
  P.tap(row);
  await settle(P, table);
  assert.equal(P.findByClass("ovrun").length, 1, "the & row opens like any other");
});

test("the hub with no runs says so in the Runs screen's own words", async () => {
  const P = loadPage({ layout: "desktop", clock: () => T });
  await settle(P, [[(u) => /^\/api\/runs(\?|$)/.test(u), { ...RUNS, runs: [] }], ...replies().slice(1)]);
  const empty = P.findByClass("empty").map((e) => e.textContent);
  assert.ok(empty.some((t) => /no runs under ~\/\.swarm\/runs yet/.test(t)), "the hub's empty feed: " + JSON.stringify(empty));
});

// The flyout's reads are optional: one that never answers must not hold the feed back.
test("a flyout read that stalls does not hold the run feed back", async () => {
  const P = loadPage({ layout: "desktop", clock: () => T });
  for (let n = 0; n < 4; n++) {
    await P.flush();
    for (const url of P.pendingUrls()) {
      if (url === "/api/usage") continue; // never answers
      const reply = replies().find(([m]) => m(url));
      P.respond((u) => u === url, reply[1]);
    }
  }
  P.fireTimers(1500);
  await P.flush(); await P.flush();
  assert.equal(P.findByClass("rcard").length, 2, "the live cards draw without the stalled read");
});

// The run screen's desktop cut is laid out by rules keyed to main's own children; the
// hub nests that cut inside `.ovrun`, so every such rule must also reach it there.
test("every run-screen desktop rule also reaches the run opened on the hub", () => {
  const css = readFileSync(new URL("../src/serve/desktop.css", import.meta.url), "utf8");
  const bare = css.split("\n").filter((l) => l.includes("main:has(> .banner):has(> .graph)") && !l.includes(":is(main:has(> .banner):has(> .graph), .ovrun)"));
  assert.deepEqual(bare.map((l) => l.trim().slice(0, 80)).filter((l) => !l.startsWith("main:has(> .banner):has(> .graph) {")), [], "run-screen rules the hub's .ovrun cannot reach");
  assert.match(css, /\.ovrun\)?\s*>\s*\.actionbar[^{]*\{[^}]*position:\s*static/, "the report bar sits in the opened run, never fixed over the hub");
});

// A leaf reached from the run the hub opened replaces that run under its row: the hub
// never navigates away from its sidebar, and the leaf's way back to the tree returns.
test("a leaf opened from the hub's run takes the run's place, and Show in tree returns", async () => {
  const P = await hub({ run: runPayload("DONE_2") });
  P.tap(rowNamed(P, "DONE_2"));
  await settle(P, replies({ run: runPayload("DONE_2") }));
  const leafRow = P.findByClass("row").find((e) => e.getAttribute("data-href").endsWith("/leaf/leaf-a"));
  P.tap(leafRow);
  await settle(P, replies({ run: runPayload("DONE_2") }), [/\/leaves\//]);
  assert.equal(P.location.hash, "#/overview", "opening the leaf is not a navigation");
  assert.equal(P.findByClass("ovleaf").length, 1, "the leaf opens beneath the row");
  assert.equal(P.findByClass("ovrun").length, 0, "in the run's place");
  assert.equal(P.findByClass("ovpanel").length, 1, "and the sidebar stays");
  assert.ok(P.fetchLog.includes(OPENED_URL + "/leaves/leaf-a"), "from the leaf screen's own endpoint");
  P.tap(P.findByClass("show")[0]);
  await settle(P, replies({ run: runPayload("DONE_2") }));
  assert.equal(P.findByClass("ovrun").length, 1, "Show in tree returns to the run");
  assert.equal(P.findByClass("ovleaf").length, 0);
  assert.equal(P.location.hash, "#/overview");
});

// The toggle heads the sidebar's column, not the feed: shut, the feed must not hold it.
test("the flyout toggle is main's, beside the feed, open or shut", async () => {
  const P = await hub();
  const bar = () => P.findByClass("ovbar")[0];
  assert.equal(bar().parentNode, P.main, "open: the toggle heads the sidebar column");
  P.tap(P.findByClass("ovtoggle")[0]);
  await settle(P);
  assert.equal(bar().parentNode, P.main, "shut: still main's, never inside the feed");
});

test("the leaf screen and the hub's leaf fill main, uncapped", () => {
  const css = readFileSync(new URL("../src/serve/desktop.css", import.meta.url), "utf8");
  const leaf = css.split("\n").filter((l) => l.includes(".chips.hero") || l.includes(".ovleaf"));
  assert.ok(leaf.length > 0);
  assert.deepEqual(leaf.filter((l) => /max-width\s*:\s*1100px/.test(l)), [], "no leaf rule caps it at the reading width");
});
