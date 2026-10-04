#!/usr/bin/env node
// Desktop-layout geometry probe: sidebar inside its clamp, no overlap, no sideways
// scroll, table cells aligned per column and their fr ratio — measured in a real
// headless browser over an in-process dashboard (zero npm deps), because "it looks
// right" is not a measurement.
// Outside `npm test`: node plugins/swarm/scripts/probe-desktop-layout.mjs [--browser <path>]; exits 1 outside tolerance.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/serve/server.mjs";
import { connect, devtoolsPort, evaluate, findBrowser, getJson, pageTarget, sleep, waitFor } from "./lib/cdp.mjs";

const TOL_PX = 1;
// Relative, not absolute: the fr tracks' floors (minmax(<n>ch, 1fr)) can bind at the
// narrow end, and 0.8fr of a small track rounds harder than 1fr of a large one.
const TOL_FR = 0.03;
// 68.75em at the initial 16px root = 1100px, so 800 is a phone width and the three
// above it are desktop ones.
const PASSES = [
  { name: "phone-800", width: 800, height: 900, mobile: true, desktop: false },
  { name: "desktop-1280", width: 1280, height: 900, mobile: false, desktop: true },
  { name: "desktop-1440", width: 1440, height: 900, mobile: false, desktop: true },
  { name: "desktop-1920", width: 1920, height: 1080, mobile: false, desktop: true },
  // The Overview hub, at each desktop width, paired with the Runs pass above it: the
  // feed's width is checked against that pass's own measured section width, so "as wide
  // as the Runs screen" is an equality between two boxes rather than a second opinion
  // about the stylesheet. Each hub pass runs after its Runs pass, in this order.
  { name: "desktop-1280-hub", width: 1280, height: 900, mobile: false, desktop: true, hub: true },
  { name: "desktop-1440-hub", width: 1440, height: 900, mobile: false, desktop: true, hub: true },
  { name: "desktop-1920-hub", width: 1920, height: 1080, mobile: false, desktop: true, hub: true },
];
// The fr columns, in track order: three 1fr and the 0.8fr that closes the row.
const FR_RATIO = [1, 1, 1, 0.8];
// One project with two live runs and six finished ones: two live cards, and a finished
// stack deep enough that a misaligned column shows up as a row-to-row difference.
const PROJECT = "C--code-probe";
const LIVE = { project: PROJECT, name: "live-run", active: true, aborted: false, stopped: false, mtimeMs: Date.now(), group: PROJECT, groupLabel: "probe", startedMs: Date.now() - 60_000, finishedMs: null, byState: { running: 2, ok: 1 }, leaves: 3, waves: 1, tokens: 48_000, hasDigest: false };
const LIVE_2 = { ...LIVE, name: "live-run-2" };
const FINISHED = Array.from({ length: 6 }, (_, i) => ({
  project: PROJECT, name: `finished-run-${i}`, active: false, aborted: false, stopped: false,
  mtimeMs: Date.now() - (i + 1) * 3_600_000, group: PROJECT, groupLabel: "probe",
  startedMs: Date.now() - (i + 1) * 3_600_000 - 600_000, finishedMs: Date.now() - (i + 1) * 3_600_000,
  byState: { ok: 3, failed: 1 }, leaves: 4, waves: 2, tokens: 1_234_000 + i, hasDigest: true,
}));

// Every quantity the checks below read, in one evaluate so nothing moved between reads.
const MEASURE = `(() => {
  const r1 = (n) => Math.round(n * 10) / 10;
  const nav = document.querySelector("#nav"), main = document.querySelector("#main"), hdr = document.querySelector("#hdr");
  const nb = nav.getBoundingClientRect(), mb = main.getBoundingClientRect(), hb = hdr.getBoundingClientRect();
  const overview = document.querySelector('#nav a[data-tab="overview"]');
  const head = document.querySelector(".rtable .rhead");
  // Each row's cell left edges, header first: the alignment check is that every row
  // puts column n on the same x as every other row does.
  const cellRows = [head, ...document.querySelectorAll(".rtable > .row")].filter(Boolean)
    .map((row) => [...row.querySelectorAll(".col")].map((c) => r1(c.getBoundingClientRect().left)));
  const cols = head ? [...head.querySelectorAll(".col")].map((c) => r1(c.getBoundingClientRect().width)) : [];
  // The full-width section above the stacks: the hub's feed is checked against this box,
  // so the two widths are compared as measured rather than as both being "main's content".
  const sec = document.querySelector("main > .section");
  return {
    secW: sec ? r1(sec.getBoundingClientRect().width) : null,
    layout: getComputedStyle(document.documentElement).getPropertyValue("--layout").trim(),
    navW: r1(nb.width), navRight: r1(nb.right), navBottom: r1(nb.bottom), navLeft: r1(nb.left),
    mainLeft: r1(mb.left), mainW: r1(mb.width), hdrLeft: r1(hb.left),
    overviewHidden: overview ? getComputedStyle(overview).display === "none" : null,
    rootOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    mainOverflow: main.scrollWidth - main.clientWidth,
    tables: document.querySelectorAll(".rtable").length,
    cols, cellRows,
    vw: window.innerWidth, vh: window.innerHeight,
  };
})()`;

// The loading skeleton, drawn alone in main as skeletonFor draws it, for a list screen and
// for a run: its blocks' width is compared with the Runs screen's own section, so "the
// skeleton is as wide as the screen it stands in for" is two measured boxes.
const SKELETON_MEASURE = `(() => {
  const main = document.querySelector("#main"), was = main.innerHTML, w = {};
  for (const view of ["runs", "run"]) {
    main.innerHTML = '<div class="skeleton" data-view="' + view + '"><div class="sk"></div></div>';
    w[view] = Math.round(main.querySelector(".sk").getBoundingClientRect().width * 10) / 10;
  }
  main.innerHTML = was;
  return w;
})()`;

// The hub's own quantities: where the feed's edges land, and where the flyout's right edge
// lands once it is open. Read as a function so the same expression serves the closed, open
// and re-closed reads — the three are compared to each other, so they must be one query.
const HUB_MEASURE = `(() => {
  const r1 = (n) => Math.round(n * 10) / 10;
  const main = document.querySelector("#main");
  const feed = document.querySelector(".ovfeed"), panel = document.querySelector(".ovpanel");
  return {
    layout: getComputedStyle(document.documentElement).getPropertyValue("--layout").trim(),
    shut: feed ? feed.classList.contains("shut") : null,
    feedW: feed ? r1(feed.getBoundingClientRect().width) : null,
    panelRight: panel ? r1(panel.getBoundingClientRect().right) : null,
    hasPanel: !!panel,
    rootOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    mainOverflow: main.scrollWidth - main.clientWidth,
    vw: window.innerWidth,
  };
})()`;

// A live run opened in place: the hub draws its .ovrun straight after the card (desktop.js
// openBeneath). The opened run's own content needs a run on disk, so the probe stands in a
// block of fixed height where it lands — what is measured is where the grid puts that
// block and the card beside it, which the stylesheet alone decides.
const OPEN_LIVE_MEASURE = `(() => {
  const r1 = (n) => Math.round(n * 10) / 10;
  const cards = [...document.querySelectorAll(".ovfeed > .rcard")];
  if (cards.length < 2) return { missing: "fewer than two live cards on the hub" };
  const open = document.createElement("div");
  open.className = "ovrun"; open.style.height = "120px";
  cards[0].after(open);
  const [a, b] = cards.map((c) => c.getBoundingClientRect()), o = open.getBoundingClientRect();
  const feed = document.querySelector(".ovfeed").getBoundingClientRect();
  open.remove();
  const box = (r) => ({ left: r1(r.left), right: r1(r.right), top: r1(r.top), bottom: r1(r.bottom) });
  return { feed: box(feed), first: box(a), second: box(b), open: box(o), cardGap: r1(parseFloat(getComputedStyle(cards[0]).marginTop)) };
})()`;

async function measure(client, pass) {
  let missing = null;
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: pass.width, height: pass.height, deviceScaleFactor: 1, mobile: pass.mobile,
  });
  // A per-pass query string, because the old document stays up until the new one
  // commits: without it a wait can be satisfied by the PREVIOUS pass's page and the
  // measurement then reads a screen that was never opened.
  await client.send("Page.navigate", { url: `${ORIGIN}/?probe=${pass.name}#/` });
  await waitFor(client, `location.search === "?probe=${pass.name}" && document.querySelectorAll(".rcard").length > 0`, "the live run card");
  // A project's finished stack is collapsed until it is opened (page.html's (d)) —
  // the tap is the same gesture on both layouts, so the probe makes it on both.
  await evaluate(client, `(() => { const s = document.querySelector(".section[data-project]"); if (s) s.click(); return !!s; })()`);
  if (pass.desktop) {
    const table = await waitFor(client, `document.querySelectorAll(".rtable > .row .col").length > 0`, "the finished-runs table", true);
    if (!table) missing = "the finished-runs table never rendered";
  } else {
    // The phone must open its stack too: ".rtable is absent" then measures a rendered
    // section, not one that was never exercised.
    const opened = await waitFor(client, `document.querySelector('ul[data-key^="pl:"]') != null`, "the opened finished stack on the phone", true);
    if (!opened) missing = "the finished stack never opened on the phone";
  }
  await sleep(150); // settle the re-render before reading boxes
  const m = await evaluate(client, MEASURE);
  if (pass.desktop) m.skel = await evaluate(client, SKELETON_MEASURE);
  if (missing) m.missing = missing;
  return m;
}

// The hub's pass: one navigation, three reads. The toggle's own state outlives a
// navigation (localStorage), so the closed read forces the state rather than assuming the
// default — otherwise a pass would silently measure whatever the previous pass left.
async function measureHub(client, pass) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: pass.width, height: pass.height, deviceScaleFactor: 1, mobile: pass.mobile,
  });
  await client.send("Page.navigate", { url: `${ORIGIN}/?probe=${pass.name}#/overview` });
  const up = await waitFor(client, `location.search === "?probe=${pass.name}" && document.querySelector(".ovfeed") != null`, "the hub's run feed", true);
  const m = { missing: up ? null : "the hub's run feed never rendered" };
  if (!up) return m;
  const click = `(() => { const b = document.querySelector(".ovtoggle"); if (b) b.click(); return !!b; })()`;
  m.hasToggle = await evaluate(client, `document.querySelector(".ovtoggle") != null`);
  if (!m.hasToggle) return m;
  await evaluate(client, `(() => { const f = document.querySelector(".ovfeed"); if (!f.classList.contains("shut")) document.querySelector(".ovtoggle").click(); return true; })()`);
  await sleep(200);
  m.closed = await evaluate(client, HUB_MEASURE);
  await evaluate(client, click);
  await sleep(200);
  m.open = await evaluate(client, HUB_MEASURE);
  await evaluate(client, click);
  await sleep(200);
  m.reclosed = await evaluate(client, HUB_MEASURE);
  m.openLive = await evaluate(client, OPEN_LIVE_MEASURE);
  return m;
}

// ── checks ──────────────────────────────────────────────────────────────────
const r2 = (n) => Math.round(n * 100) / 100;
// The clamp the CSS declares: clamp(180px, 14vw, 240px).
const sidebarExpected = (vw) => Math.min(240, Math.max(180, 0.14 * vw));

function check(pass, m, failures) {
  const tag = pass.name;
  if (pass.desktop) {
    if (m.layout !== "desktop") failures.push(`${tag}: --layout is ${JSON.stringify(m.layout)}, not desktop`);
    const want = sidebarExpected(m.vw);
    if (Math.abs(m.navW - want) > TOL_PX) failures.push(`${tag}: sidebar ${m.navW}px, clamp() says ${r2(want)}px`);
    if (m.navRight > m.mainLeft + TOL_PX) failures.push(`${tag}: sidebar right ${m.navRight} overlaps main left ${m.mainLeft}`);
    if (m.hdrLeft < m.navRight - TOL_PX) failures.push(`${tag}: header left ${m.hdrLeft} sits under the sidebar (right ${m.navRight})`);
    if (m.missing) failures.push(`${tag}: ${m.missing}`);
    if (!m.cellRows.length) failures.push(`${tag}: no table cells measured`);
    // Column alignment: every row's nth cell shares an x with the header's nth.
    const head = m.cellRows[0] || [];
    for (const row of m.cellRows.slice(1)) {
      if (!row.length) { failures.push(`${tag}: a row rendered without cells`); continue; }
      for (let i = 0; i < head.length; i++) {
        if (Math.abs(row[i] - head[i]) > TOL_PX) failures.push(`${tag}: column ${i} drifts ${r2(row[i] - head[i])}px from the header`);
      }
    }
    // A list screen's skeleton spans the screen it stands in for; a run's keeps the run's cap.
    if (m.skel && m.secW != null && Math.abs(m.skel.runs - m.secW) > TOL_PX) failures.push(`${tag}: the Runs skeleton is ${m.skel.runs}px, the Runs screen's sections are ${m.secW}px`);
    if (m.skel && m.skel.run > 1100 + TOL_PX) failures.push(`${tag}: the run skeleton is ${m.skel.run}px, past the run screen's 1100px cap`);
    // The fr tracks, as the ratio of the widths the four cells actually got.
    if (!m.cols.length) failures.push(`${tag}: the header cells were not measured (.rhead missing)`);
    else m.cols.forEach((w, i) => {
      const got = w / m.cols[0], want = FR_RATIO[i];
      if (Math.abs(got - want) / want > TOL_FR) failures.push(`${tag}: track ${i} is ${r2(got)}fr of ${want}fr (width ${w}px)`);
    });
  } else {
    if (m.layout === "desktop") failures.push(`${tag}: --layout says desktop below the breakpoint`);
    if (m.overviewHidden !== true) failures.push(`${tag}: the Overview link is not hidden on the phone`);
    if (Math.abs(m.navBottom - m.vh) > TOL_PX) failures.push(`${tag}: the bar's foot ${m.navBottom} is not the viewport's ${m.vh}`);
    if (m.missing) failures.push(`${tag}: ${m.missing}`);
    // The stack is open (missing above covers a failed open), so a table here would
    // be the desktop one leaking below the breakpoint.
    if (m.tables !== 0) failures.push(`${tag}: ${m.tables} table(s) rendered on the phone`);
  }
  if (m.rootOverflow > TOL_PX) failures.push(`${tag}: the document scrolls sideways by ${m.rootOverflow}px`);
  if (m.mainOverflow > TOL_PX) failures.push(`${tag}: the main column scrolls sideways by ${m.mainOverflow}px`);
}

// The hub at desktop width: the feed holds the Runs screen's own width while the flyout is
// shut, the flyout takes a track of its own and stays inside the window when open, and the
// feed gets its width back when it shuts again. `runsSecW` is the section width measured on
// the Runs pass at this same width — null means that pass failed to measure one, which it
// reports itself, so this check stays quiet rather than doubling the failure.
function checkHub(pass, m, failures, runsSecW) {
  const tag = pass.name;
  if (!m.closed) { if (m.missing) failures.push(`${tag}: ${m.missing}`); return; }
  if (m.closed.layout !== "desktop") failures.push(`${tag}: --layout is ${JSON.stringify(m.closed.layout)}, not desktop`);
  for (const [when, r] of [["shut", m.closed], ["open", m.open], ["re-shut", m.reclosed]]) {
    if (!r) { failures.push(`${tag}: no ${when} measurement`); continue; }
    if (r.rootOverflow > TOL_PX) failures.push(`${tag}: ${when} — the document scrolls sideways by ${r.rootOverflow}px`);
    if (r.mainOverflow > TOL_PX) failures.push(`${tag}: ${when} — the main column scrolls sideways by ${r.mainOverflow}px`);
  }
  if (!m.hasToggle) { failures.push(`${tag}: the hub drew no flyout toggle`); return; }
  if (runsSecW != null && m.closed.feedW != null && Math.abs(m.closed.feedW - runsSecW) > TOL_PX) {
    failures.push(`${tag}: the shut hub's feed is ${m.closed.feedW}px, the Runs screen's sections are ${runsSecW}px`);
  }
  if (!m.open.hasPanel) {
    failures.push(`${tag}: the open hub drew no flyout panel`);
  } else {
    if (m.open.panelRight > m.open.vw + TOL_PX) failures.push(`${tag}: the flyout's right edge ${m.open.panelRight} is past the viewport's ${m.open.vw}`);
    if (m.open.feedW >= m.closed.feedW) failures.push(`${tag}: opening the flyout did not take a track (feed ${m.open.feedW}px, was ${m.closed.feedW}px)`);
  }
  // The hub's live runs are an accordion: every card spans the feed, and an opened run
  // drops beneath its own card, on the card's edges, at the gap the cards keep, with the
  // next card after it.
  const ol = m.openLive;
  if (!ol || ol.missing) failures.push(`${tag}: ${ol ? ol.missing : "no open-live measurement"}`);
  else {
    for (const [what, b] of [["first card", ol.first], ["second card", ol.second], ["open run", ol.open]]) {
      if (Math.abs(b.left - ol.feed.left) > TOL_PX || Math.abs(b.right - ol.feed.right) > TOL_PX) failures.push(`${tag}: the ${what} spans ${b.left}–${b.right}, not the feed's ${ol.feed.left}–${ol.feed.right}`);
    }
    if (Math.abs(ol.open.top - ol.first.bottom - ol.cardGap) > TOL_PX) failures.push(`${tag}: the open run starts ${r2(ol.open.top - ol.first.bottom)}px under its card, not the cards' ${ol.cardGap}px gap`);
    if (ol.second.top < ol.open.bottom) failures.push(`${tag}: the second card (top ${ol.second.top}) is not below the open run (bottom ${ol.open.bottom})`);
  }
  if (m.reclosed && Math.abs(m.reclosed.feedW - m.closed.feedW) > TOL_PX) {
    failures.push(`${tag}: re-shutting the flyout left the feed at ${m.reclosed.feedW}px, not ${m.closed.feedW}px`);
  }
}

// ── run ─────────────────────────────────────────────────────────────────────
let ORIGIN = "";
let home = null, profile = null, browser = null, browserWs = null;

async function main() {
  const exe = findBrowser();
  home = mkdtempSync(join(tmpdir(), "swarm-desktop-probe-"));
  profile = mkdtempSync(join(tmpdir(), "swarm-desktop-profile-"));
  const rows = [LIVE, LIVE_2, ...FINISHED];
  const estate = { current: () => Promise.resolve({ version: 1, rows }), refresh() {}, onSnapshot() {}, close() {} };
  const cfg = { dashboard: { port: 0, bind: "127.0.0.1", token: null }, grading: true };
  const server = createServer({ home, cfg, _estate: estate, _watch: () => ({ close() {} }), _heartbeatMs: 60_000, _pollMs: 60_000 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  ORIGIN = `http://127.0.0.1:${server.address().port}`;

  browser = spawn(exe, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-gpu",
    "--window-size=1280,900", "about:blank",
  ], { stdio: "ignore" });
  const pid = browser.pid;

  try {
    const port = await devtoolsPort(profile, browser);
    const version = await getJson(`http://127.0.0.1:${port}/json/version`);
    browserWs = await connect(version.webSocketDebuggerUrl);
    const target = await pageTarget(port);
    const client = await connect(target.webSocketDebuggerUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");

    const failures = [];
    // The section width each Runs pass measured, by viewport width: the hub pass at that
    // width is checked against it, so the two screens are compared at the same size.
    const runsSecW = new Map();
    for (const pass of PASSES) {
      const m = pass.hub ? await measureHub(client, pass) : await measure(client, pass);
      // The printed row is the record: the numbers, not a verdict.
      if (pass.hub) {
        checkHub(pass, m, failures, runsSecW.get(pass.width));
        const shut = m.closed ? `${m.closed.feedW}px` : "—";
        const open = m.open ? `${m.open.feedW}px flyout -> ${m.open.panelRight} of ${m.open.vw}` : "—";
        console.log(`${pass.name.padEnd(18)} ${String(m.closed ? m.closed.vw : pass.width).padStart(4)}px  feed shut ${shut.padStart(7)}  open ${open}  overflow ${m.closed ? `${m.closed.rootOverflow}/${m.open ? m.open.rootOverflow : "-"}` : "-"}  open-live ${m.openLive && !m.openLive.missing ? `gap ${r2(m.openLive.open.top - m.openLive.first.bottom)}px, card ${m.openLive.first.left}–${m.openLive.first.right}, run ${m.openLive.open.left}–${m.openLive.open.right}` : "—"}`);
      } else {
        check(pass, m, failures);
        if (m.secW != null) runsSecW.set(pass.width, m.secW);
        const cols = m.cols.length ? `  tracks ${m.cols.join(" / ")}` : "";
        console.log(`${pass.name.padEnd(18)} ${String(m.vw).padStart(4)}px  sidebar ${String(m.navW).padStart(6)}  main ${String(m.mainW).padStart(6)}  gap ${String(r2(m.mainLeft - m.navRight)).padStart(5)}  section ${String(m.secW).padStart(6)}  skeleton ${m.skel ? `${m.skel.runs}/${m.skel.run}` : "—"}  overflow ${m.rootOverflow}/${m.mainOverflow}${cols}`);
      }
    }
    console.log(`\n${PASSES.length} passes, tolerance ${TOL_PX}px and ${TOL_FR * 100}% on the fr ratio`);
    if (failures.length) {
      console.log(`\nFAIL — ${failures.length} outside tolerance (or missing):`);
      for (const f of failures) console.log(`  ${f}`);
      process.exitCode = 1;
    } else {
      console.log("PASS — the sidebar holds its clamp, nothing overlaps, nothing scrolls sideways, the columns align, the fr ratio holds, and the hub's feed and flyout stay inside the window");
    }
    client.close();
  } finally {
    await shutdown(server, pid);
  }
}

// Never a name-based kill: `Browser.close` first, then the tree under the PID we
// spawned, and nothing else.
async function shutdown(server, pid) {
  try { await browserWs?.send("Browser.close"); } catch {}
  browserWs?.close();
  const exited = browser && await Promise.race([
    new Promise((r) => browser.once("exit", () => r(true))),
    sleep(4000).then(() => false),
  ]);
  if (!exited && browser) {
    try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  }
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  // Edge can hold the profile open for a beat after exit — retry, never fail on it.
  for (const dir of [home, profile]) {
    if (!dir) continue;
    for (let i = 0; i < 5; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break; }
      catch { await sleep(300); }
    }
    if (existsSync(dir)) console.log(`note: could not remove ${dir}`);
  }
}

await main();
