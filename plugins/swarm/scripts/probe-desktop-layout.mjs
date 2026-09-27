#!/usr/bin/env node
// Desktop-layout geometry probe: the sidebar stays inside its clamp, the main column
// never overlaps it, nothing scrolls sideways, the Runs table's cells line up per
// column and its fr tracks keep their declared ratio — measured in a real headless
// browser over an in-process dashboard (temp SWARM_HOME, DevTools protocol, zero npm
// deps), because "it looks right" is not a measurement.
// Outside `npm test`: node plugins/swarm/scripts/probe-desktop-layout.mjs [--browser <path>]
// Exits 1 when any check is outside tolerance; removes its temp dirs, kills only its own browser.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/serve/server.mjs";

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
];
// The fr columns, in track order: three 1fr and the 0.8fr that closes the row.
const FR_RATIO = [1, 1, 1, 0.8];
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

// One project with a live run and six finished ones: a live card above, and a finished
// stack deep enough that a misaligned column shows up as a row-to-row difference.
const PROJECT = "C--code-probe";
const LIVE = { project: PROJECT, name: "live-run", active: true, aborted: false, stopped: false, mtimeMs: Date.now(), group: PROJECT, groupLabel: "probe", startedMs: Date.now() - 60_000, finishedMs: null, byState: { running: 2, ok: 1 }, leaves: 3, waves: 1, tokens: 48_000, hasDigest: false };
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
  return {
    layout: getComputedStyle(document.documentElement).getPropertyValue("--layout").trim(),
    navW: r1(nb.width), navRight: r1(nb.right), navBottom: r1(nb.bottom), navLeft: r1(nb.left),
    mainLeft: r1(mb.left), mainW: r1(mb.width), hdrLeft: r1(hb.left),
    overviewHidden: overview ? getComputedStyle(overview).display === "none" : null,
    rootOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    mainOverflow: main.scrollWidth - main.clientWidth,
    tables: document.querySelectorAll(".rtable").length,
    cols, cellRows,
    vw: window.innerWidth,
  };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function findBrowser() {
  const explicit = arg("--browser") || process.env.SWARM_PROBE_BROWSER;
  for (const c of [explicit, EDGE, ...CHROME].filter(Boolean)) if (existsSync(c)) return c;
  for (const name of ["chrome", "google-chrome", "chromium"]) {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
    const first = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && existsSync(first)) return first;
  }
  throw new Error(`no browser found — pass --browser <path>`);
}

// ── the DevTools client ─────────────────────────────────────────────────────
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiting = new Map();
    let nextId = 1;
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      const w = msg.id != null && waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
    });
    ws.addEventListener("error", () => reject(new Error(`websocket failed: ${url}`)));
    ws.addEventListener("open", () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        return new Promise((res, rej) => { waiting.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
      },
      close() { try { ws.close(); } catch {} },
    }));
  });
}

const getJson = async (url) => (await fetch(url)).json();

async function devtoolsPort(userDataDir, child) {
  const file = join(userDataDir, "DevToolsActivePort");
  for (let i = 0; i < 200; i++) {
    if (existsSync(file)) {
      const port = Number(readFileSync(file, "utf8").split("\n")[0]);
      if (port) return port;
    }
    if (child.exitCode != null) throw new Error(`browser exited early (code ${child.exitCode})`);
    await sleep(100);
  }
  throw new Error("browser never wrote DevToolsActivePort");
}

async function pageTarget(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(100);
  }
  throw new Error("no page target appeared");
}

async function evaluate(client, expression) {
  const r = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluate threw");
  return r.result.value;
}

// The table is the thing under test, so a missing one is a RESULT, not a crash: the
// soft wait lets the geometry checks still run and report what they did measure.
async function waitFor(client, expression, what, soft = false) {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(client, expression)) return true;
    await sleep(100);
  }
  if (soft) return false;
  throw new Error(`timed out waiting for ${what}`);
}

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
  if (pass.desktop) {
    // A project's finished stack is collapsed until it is opened (page.html's (d)) —
    // the tap is the same gesture on both layouts, so the probe makes it.
    await evaluate(client, `(() => { const s = document.querySelector(".section[data-project]"); if (s) s.click(); return !!s; })()`);
    const table = await waitFor(client, `document.querySelectorAll(".rtable > .row .col").length > 0`, "the finished-runs table", true);
    if (!table) missing = "the finished-runs table never rendered";
  }
  await sleep(150); // settle the re-render before reading boxes
  const m = await evaluate(client, MEASURE);
  if (missing) m.missing = missing;
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
      for (let i = 0; i < head.length; i++) {
        if (Math.abs(row[i] - head[i]) > TOL_PX) failures.push(`${tag}: column ${i} drifts ${r2(row[i] - head[i])}px from the header`);
      }
    }
    // The fr tracks, as the ratio of the widths the four cells actually got.
    const base = m.cols[0];
    m.cols.forEach((w, i) => {
      if (!base) return;
      const got = w / base, want = FR_RATIO[i];
      if (Math.abs(got - want) / want > TOL_FR) failures.push(`${tag}: track ${i} is ${r2(got)}fr of ${want}fr (width ${w}px)`);
    });
  } else {
    if (m.layout === "desktop") failures.push(`${tag}: --layout says desktop below the breakpoint`);
    if (m.overviewHidden !== true) failures.push(`${tag}: the Overview link is not hidden on the phone`);
    if (m.navBottom < m.vw - TOL_PX) failures.push(`${tag}: the bar's foot ${m.navBottom} is not the viewport's`);
    if (m.tables !== 0) failures.push(`${tag}: ${m.tables} table(s) rendered on the phone`);
  }
  if (m.rootOverflow > TOL_PX) failures.push(`${tag}: the document scrolls sideways by ${m.rootOverflow}px`);
  if (m.mainOverflow > TOL_PX) failures.push(`${tag}: the main column scrolls sideways by ${m.mainOverflow}px`);
}

// ── run ─────────────────────────────────────────────────────────────────────
let ORIGIN = "";
let home = null, profile = null, browser = null, browserWs = null;

async function main() {
  const exe = findBrowser();
  home = mkdtempSync(join(tmpdir(), "swarm-desktop-probe-"));
  profile = mkdtempSync(join(tmpdir(), "swarm-desktop-profile-"));
  const rows = [LIVE, ...FINISHED];
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
    for (const pass of PASSES) {
      const m = await measure(client, pass);
      check(pass, m, failures);
      // The printed row is the record: the numbers, not a verdict.
      const cols = m.cols.length ? `  tracks ${m.cols.join(" / ")}` : "";
      console.log(`${pass.name.padEnd(14)} ${String(m.vw).padStart(4)}px  sidebar ${String(m.navW).padStart(6)}  main ${String(m.mainW).padStart(6)}  gap ${String(r2(m.mainLeft - m.navRight)).padStart(5)}  overflow ${m.rootOverflow}/${m.mainOverflow}${cols}`);
    }
    console.log(`\n${PASSES.length} passes, tolerance ${TOL_PX}px and ${TOL_FR * 100}% on the fr ratio`);
    if (failures.length) {
      console.log(`\nFAIL — ${failures.length} outside tolerance (or missing):`);
      for (const f of failures) console.log(`  ${f}`);
      process.exitCode = 1;
    } else {
      console.log("PASS — the sidebar holds its clamp, nothing overlaps, nothing scrolls sideways, the columns align and the fr ratio holds");
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
