#!/usr/bin/env node
// Rank-row geometry probe: does every perf rank row put the grade's vertical
// centre on the rank marker's centre? Rank rows carry no coin badge (coins live
// on the cost screen); the probe fails if one reappears.
//
// Real browser, real layout — the geometry is a fact about a layout engine, so
// it is measured in one rather than reasoned about. An in-process dashboard over
// a temp SWARM_HOME, headless Chromium driven over the DevTools protocol, one
// zero-height inline-block per row to read the grade's baseline. Zero npm deps:
// node:http + node:child_process + the global WebSocket.
//
// Lives outside `npm test` (needs a browser and a few seconds):
//
//   node plugins/swarm/scripts/probe-rank-align.mjs [--browser <path>]
//
// Exits 1 when any |delta| > TOL_PX. Removes its own temp dirs and kills only
// the browser PID it spawned.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/serve/server.mjs";

const TOL_PX = 1;
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];
// The three shapes the fix must hold in: a card at desktop width, the same card
// on a phone, and the compact list (a shorter value and a smaller trophy, so its
// drift is its own).
const PASSES = [
  { name: "desktop", width: 1280, height: 900, mobile: false, compact: false },
  { name: "phone", width: 390, height: 844, mobile: true, compact: false },
  { name: "phone-compact", width: 390, height: 844, mobile: true, compact: true },
];
// Enough graded models that both badge shapes render: ranks 1-3 wear a trophy,
// the rest a disc. The cost shares are log-spread over one provider axis (mult
// 1,2,4,8,16 -> coins 1..5), so the coin stack's height varies row to row; the
// last model has no history at all, which is the `.cbadge.none` em-dash.
const MODELS = [
  { model: "probe-a:cloud", grade: 10, share: 1 },
  { model: "probe-b:cloud", grade: 9, share: 2 },
  { model: "probe-c:cloud", grade: 8, share: 4 },
  { model: "probe-d:cloud", grade: 7, share: 8 },
  { model: "probe-e:cloud", grade: 6, share: 16 },
  { model: "probe-f:cloud", grade: 6, share: 16 },
  { model: "probe-g:cloud", grade: 5, share: 1 },
  { model: "probe-h", grade: 4, share: null },
];
const GRADES = { adherence: null, handoff: null, truthfulness: null, depth: null, discrimination: null, code: null, impl: null, search: null, web: null, vision: null, geometry: null };
const REQUESTS = 400; // over THIN_REQUESTS, so no row is flagged thin

const MEASURE = `(() => {
  const r2 = (n) => Math.round(n * 100) / 100;
  const rows = [...document.querySelectorAll(".crow")];
  return rows.map((row, i) => {
    const rk = row.querySelector(".rk"), val = row.querySelector(".val");
    const badge = row.querySelector(".cbadge.coins");
    // The STACK's box, not the badge span around it: a span whose used height is
    // clamped out of the line would report its own foot as the baseline, and the
    // check would pass by construction. The svg is the artwork.
    const coin = badge ? (badge.querySelector("svg") || badge) : null;
    if (!rk || !val) return { i, model: "", error: "row has no .rk/.val" };
    const vb = val.getBoundingClientRect(), rb = rk.getBoundingClientRect();
    // A zero-height inline-block sits ON the line's baseline, so its bottom edge
    // IS the grade text's baseline. Added after the boxes above are read, so it
    // cannot move what is being measured.
    const probe = document.createElement("span");
    probe.setAttribute("style", "display:inline-block;width:0;height:0");
    val.appendChild(probe);
    const pb = probe.getBoundingClientRect();
    probe.remove();
    const nm = row.querySelector(".nm");
    return {
      i,
      model: nm ? nm.textContent.trim() : "",
      trophy: !!row.querySelector(".rk.trophy"),
      kind: coin ? "coins" : (row.querySelector(".cbadge") ? "none" : "no-badge"),
      grade: r2((vb.top + vb.bottom) / 2 - (rb.top + rb.bottom) / 2),
      coin: coin ? r2(coin.getBoundingClientRect().bottom - pb.bottom) : null,
    };
  });
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

// ── the fixture home ────────────────────────────────────────────────────────
function seedHome() {
  const home = mkdtempSync(join(tmpdir(), "swarm-rank-"));
  writeFileSync(join(home, "model-scores.jsonl"), MODELS.map((m, i) => JSON.stringify({
    ts: "2026-09-26T00:00:00Z", resultsDir: "/r/probe-1", leaf: `leaf-${i}`, model: m.model, effort: null,
    domain: "node", grades: { ...GRADES, adherence: m.grade, handoff: m.grade, truthfulness: m.grade, depth: m.grade },
    outcome: "completed", note: "", assessedBy: { session: "probe" },
  })).join("\n") + "\n", "utf8");
  writeFileSync(join(home, "usage-history.jsonl"), JSON.stringify({
    weeklyPctUsed: 50,
    weeklyModels: MODELS.filter((m) => m.share != null).map((m) => ({ model: m.model.replace(/:cloud$/, ""), requests: REQUESTS, meterSharePct: m.share })),
  }) + "\n", "utf8");
  return home;
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

// The browser writes its port here once the debug socket is up (port 0 = pick one).
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

async function waitFor(client, expression, what) {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(client, expression)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function measure(client, pass) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: pass.width, height: pass.height, deviceScaleFactor: 1, mobile: pass.mobile,
  });
  await client.send("Page.navigate", { url: BASE_URL });
  await waitFor(client, `document.querySelectorAll(".crow").length > 0`, ".crow rows");
  if (pass.compact) {
    // The compact list is a stored preference, not a width breakpoint: tick the
    // real checkbox so the rows under test are the ones the operator sees.
    await evaluate(client, `(() => { const cb = document.querySelector('input[data-compact="rank"]'); if (cb && !cb.checked) cb.click(); return !!cb; })()`);
    await waitFor(client, `document.querySelectorAll(".rlist.compact .crow").length > 0`, "the compact list");
  }
  await sleep(150); // settle the re-render before reading boxes
  return evaluate(client, MEASURE);
}

// ── run ─────────────────────────────────────────────────────────────────────
let BASE_URL = "";
let home = null, profile = null, browser = null, browserWs = null;

async function main() {
  const exe = findBrowser();
  home = seedHome();
  profile = mkdtempSync(join(tmpdir(), "swarm-rank-profile-"));
  const estate = { current: () => Promise.resolve({ version: 0, runs: [] }), refresh() {}, onSnapshot() {}, close() {} };
  const cfg = { dashboard: { port: 0, bind: "127.0.0.1", token: null }, grading: { enabled: true } };
  const server = createServer({ home, cfg, _estate: estate, _watch: () => ({ close() {} }), _heartbeatMs: 60_000, _pollMs: 60_000 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  BASE_URL = `http://127.0.0.1:${server.address().port}/#/perf`;

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
    let rows = 0, worst = null;
    for (const pass of PASSES) {
      const seen = await measure(client, pass);
      if (seen.length < MODELS.length) failures.push(`${pass.name}: only ${seen.length} rows rendered, expected ${MODELS.length}`);
      if (!seen.some((r) => r.trophy)) failures.push(`${pass.name}: no trophy row rendered`);
      if (seen.some((r) => r.kind !== "no-badge")) failures.push(`${pass.name}: a rank row carries a coin badge`);
      for (const r of seen) {
        rows++;
        const parts = [];
        for (const [what, v] of [["grade-rk", r.grade], ["coin-base", r.coin]]) {
          if (v == null) { parts.push(`${what} n/a  `); continue; }
          parts.push(`${what} ${v >= 0 ? "+" : ""}${v.toFixed(2)}`);
          if (!worst || Math.abs(v) > Math.abs(worst.v)) worst = { v, what, pass: pass.name, model: r.model };
          if (Math.abs(v) > TOL_PX) failures.push(`${pass.name} #${r.i + 1} ${r.model}: ${what} ${v.toFixed(2)}px`);
        }
        console.log(`${pass.name.padEnd(14)} #${String(r.i + 1).padEnd(2)} ${(r.model || "?").padEnd(16)} ${r.trophy ? "trophy" : "disc  "} ${r.kind.padEnd(8)} ${parts.join("  ")}`);
      }
    }
    console.log(`\n${rows} rows measured across ${PASSES.length} passes, tolerance ${TOL_PX}px`);
    console.log(`worst: ${worst ? `${worst.pass} ${worst.model} ${worst.what} ${worst.v >= 0 ? "+" : ""}${worst.v.toFixed(2)}px` : "nothing measured"}`);
    if (failures.length) {
      console.log(`\nFAIL — ${failures.length} outside tolerance (or missing):`);
      for (const f of failures) console.log(`  ${f}`);
      process.exitCode = 1;
    } else {
      console.log("PASS — every row inside tolerance at both viewports");
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
