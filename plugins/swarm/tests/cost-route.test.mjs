// Cost as its own top-level screen: `#/cost` off its own grading-independent
// endpoint, `/api/cost`, which serves the flat costView — the first build served
// the /api/perf wrapper and the screen read "no cost history yet" on real data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { createServer } from "../src/serve/server.mjs";
import { PAGE, loadPage, listData, listRow } from "./helpers/page-harness.mjs";
import { loadPerfViews, H } from "./helpers/perf-views-harness.mjs";

const estate = { current: () => Promise.resolve({ version: 0, runs: [] }), refresh() {}, onSnapshot() {}, close() {} };

async function getCost(grading) {
  const home = mkdtempSync(join(tmpdir(), "swarm-cost-"));
  writeFileSync(join(home, "usage-history.jsonl"), JSON.stringify({
    weeklyPctUsed: 50,
    weeklyModels: [{ model: "m-b", requests: 200, meterSharePct: 10 }, { model: "m-a", requests: 100, meterSharePct: 20 }],
  }) + "\n", "utf8");
  const cfg = { dashboard: { port: 0, bind: "127.0.0.1", token: null }, grading: { enabled: grading } };
  const server = createServer({ home, cfg, _estate: estate, _watch: () => ({ close() {} }), _heartbeatMs: 60_000, _pollMs: 60_000 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port: server.address().port, path: "/api/cost" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on("error", reject));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(home, { recursive: true, force: true });
  }
}

test("/api/cost serves the flat costView even with grading off — cost never needed grades", async () => {
  const { status, body } = await getCost(false);
  assert.equal(status, 200);
  assert.equal(body.views, undefined, "flat, not the /api/perf wrapper");
  const ollama = body.sections.find((s) => s.provider === "ollama");
  assert.deepEqual(ollama.spread.map((s) => s.model), ["m-b:cloud", "m-a:cloud"]);
});

test("the server's real /api/cost response renders cost cards, not the empty state", async () => {
  const { body } = await getCost(true);
  const html = loadPerfViews().costScreen(body, H, "ollama");
  assert.ok(!html.includes("no cost history yet"));
  assert.ok(html.includes("m-a:cloud") && html.includes("4×"));
});

// ── the page ─────────────────────────────────────────────────────────────
const isCost = (u) => u.startsWith("/api/cost");

async function openCost(hash, calls = []) {
  const P = loadPage({ perfViews: { costScreen: (data, h, pick) => { calls.push(pick); return `<div class="stub">screen:${data.tag}</div>`; } } });
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.location.hash = hash;
  P.fireHashchange();
  await P.flush();
  P.respond(isCost, { tag: "flat", sections: [] });
  await P.flush();
  return P;
}

test("#/cost fetches /api/cost, never /api/perf, and heads the screen the mockup's way", async () => {
  const P = await openCost("#/cost");
  assert.ok(P.fetchLog.some(isCost) && !P.fetchLog.some(P.isPerf));
  const text = P.screenText();
  assert.ok(text.includes("screen:flat"), "perf.js's cost screen drew the flat payload");
  assert.ok(text.includes("Relative cost within each provider"));
});

test("an old #/perf/cost bookmark lands on the Cost screen", async () => {
  const P = await openCost("#/perf/cost");
  assert.ok(P.screenText().includes("screen:flat"));
});

test("#/cost/<provider> hands that provider to the screen, and #/cost hands none", async () => {
  const calls = [];
  await openCost("#/cost/codex", calls);
  assert.equal(calls.at(-1), "codex");
  await openCost("#/cost", calls);
  assert.equal(calls.at(-1), null);
});

test("Cost is reached from the bottom nav, and has left the Performance switcher", () => {
  const src = readFileSync(PAGE, "utf8");
  assert.match(src, /<nav id="nav"[^]*?href="#\/cost"/);
  assert.doesNotMatch(src, /href: "#\/perf\/cost"/);
});
