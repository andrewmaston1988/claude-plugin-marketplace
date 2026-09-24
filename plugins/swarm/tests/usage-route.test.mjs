// Usage as a top-level screen: `/api/usage` is a LIVE read of every provider, so
// the page fetches it once per navigation — never on a tick, never on the switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { createServer } from "../src/serve/server.mjs";
import { PAGE, loadPage, listData, listRow } from "./helpers/page-harness.mjs";

const estate = { current: () => Promise.resolve({ version: 0, runs: [] }), refresh() {}, onSnapshot() {}, close() {} };

test("/api/usage answers from the injected live reader", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-usage-"));
  const calls = [];
  const cfg = { dashboard: { port: 0, bind: "127.0.0.1", token: null } };
  const server = createServer({ home, cfg, _estate: estate, _watch: () => ({ close() {} }), _heartbeatMs: 60_000, _pollMs: 60_000,
    _readProviderUsage: async (c, opts) => { calls.push(opts); return { usages: [{ provider: "ollama", limits: [] }], errors: {} }; } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const body = await new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port: server.address().port, path: "/api/usage" }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { b += c; });
      res.on("end", () => resolve(JSON.parse(b)));
    }).on("error", reject));
    assert.equal(body.usages[0].provider, "ollama");
    assert.deepEqual(calls, [{ live: true }]);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(home, { recursive: true, force: true });
  }
});

test("the dashboard command wires the real reader into the server", () => {
  const src = readFileSync(new URL("../scripts/swarm.mjs", import.meta.url), "utf8");
  assert.match(src, /createServer\(\{.*_readProviderUsage: readProviderUsage/);
});

// ── the page ─────────────────────────────────────────────────────────────
const isUsage = (u) => u.startsWith("/api/usage");

async function openUsage(calls = []) {
  const P = loadPage({ perfViews: { usageScreen: (data, h, w) => { calls.push(w); return `<div class="stub">usage:${data.tag}:${w}</div>`; } } });
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.location.hash = "#/usage";
  P.fireHashchange();
  await P.flush();
  P.respond(isUsage, { tag: "live", usages: [], errors: {} });
  await P.flush();
  return P;
}

const usageFetches = (P) => P.fetchLog.filter(isUsage).length;

test("#/usage fetches /api/usage once and draws the screen, Week first", async () => {
  const P = await openUsage();
  assert.equal(usageFetches(P), 1);
  assert.ok(P.screenText().includes("usage:live:week"));
  assert.ok(P.screenText().includes("allowance remaining"));
});

test("the Session/Week switch redraws from the payload already held — no second live read", async () => {
  const calls = [];
  const P = await openUsage(calls);
  P.main.contains = () => true;
  const tab = { dataset: { usageWindow: "session" }, classList: { contains: () => false } };
  P.main.listeners.click.forEach((f) => f({ target: { closest: () => tab } }));
  await P.flush();
  assert.equal(calls.at(-1), "session");
  assert.equal(usageFetches(P), 1);
  assert.match(readFileSync(PAGE, "utf8"), /e\.target\.closest\("[^"]*\[data-usage-window\]/);
});

test("ticks and SSE events never re-read usage; a fresh navigation does", async () => {
  const P = await openUsage();
  const drainLists = async () => { while (P.pendingCount()) { P.respondList(listData(listRow())); await P.flush(); } };
  P.fireTimers(1000);
  P.fireTimers(5000);
  P.fireSse("runs");
  await P.flush();
  assert.equal(usageFetches(P), 1, "a clock is not a navigation");
  await drainLists(); // the 5s tick's finished-runs poll
  P.location.hash = "#/";
  P.fireHashchange();
  await P.flush();
  await drainLists();
  P.location.hash = "#/usage";
  P.fireHashchange();
  await P.flush();
  assert.equal(usageFetches(P), 2);
});

test("Usage is reached from the menu", () => {
  assert.match(readFileSync(PAGE, "utf8"), /<nav class="nav">[^]*?href="#\/usage"/);
});
