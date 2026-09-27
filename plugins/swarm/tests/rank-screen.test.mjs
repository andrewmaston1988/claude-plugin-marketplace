// The Performance overall ranking's renderer, run for real through perf.js (see
// the harness) — and the server payload it draws. The operator deleted the old
// footer text; the runs screen's Show all row, as a Show/Hide superseded toggle, puts the
// superseded rows back in the ranking in place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { createServer } from "../src/serve/server.mjs";
import { loadPerfViews, H } from "./helpers/perf-views-harness.mjs";

const PAGE = fileURLToPath(new URL("../src/serve/page.html", import.meta.url));

const estate = { current: () => Promise.resolve({ version: 0, runs: [] }), refresh() {}, onSnapshot() {}, close() {} };

// perf.js is handed the page's own helpers; rankList is stubbed down to what a
// view test reads (labels in order), everything the view owns is the real thing.
const RANK_H = {
  ...H,
  universals: ["adherence", "handoff", "truthfulness", "depth"],
  costOf: new Map(),
  cellSub: (c, extra) => [`n=${c.n}`, ...(extra || [])].join(" · "),
  showAll: (label) => `<b class="showall">${label}</b>`,
  rankList: (rows, { podium } = {}) => `<div class="rlist">${rows.map((r, i) => `<div class="card crow${r.sup ? " sup" : ""}" data-key="${r.key}">${podium && i < 3 ? i + 1 : ""}${r.label}</div>`).join("")}</div>`,
};
const cell = (model, combined, over = {}) => ({
  model, combined, n: 6, provisional: false, wtds: {}, outcomes: {}, providers: ["ollama"], ...over,
});

const PAIR = [
  cell("deepseek-v4.1-flash:cloud", 9),
  cell("glm-5.1:cloud", 8.5),
  cell("deepseek-v4-flash:cloud", 8, { supersededBy: "deepseek-v4.1-flash:cloud" }),
];

test("the ranking's control is the shared Show all row reading Show superseded, with no footer text", () => {
  const html = loadPerfViews().rankScreen(PAIR, RANK_H);
  assert.ok(html.endsWith(`<div class="row tap more" data-superseded="1"><b class="showall">Show superseded</b></div>`), html);
  assert.ok(!html.includes("superseded by a newer model"), "the footer said nothing the control does not");
  assert.ok(!html.includes("<details"), "a toggle, not a disclosure below the list");
  assert.ok(!readFileSync(PAGE, "utf8").includes("overall = mean of"),
    "page.html must not still print the deleted footer — deleting it in perf.js alone leaves the page's own line on screen");
});

test("superseded cells are held out of the ranking until shown, then rejoin it in place, marked", () => {
  const V = loadPerfViews();
  const hidden = V.rankScreen(PAIR, RANK_H);
  assert.ok(hidden.includes("deepseek-v4.1-flash:cloud") && !hidden.includes("deepseek-v4-flash:cloud"));
  const shown = V.rankScreen(PAIR, { ...RANK_H, showSuperseded: true });
  const order = [...shown.matchAll(/data-key="m:([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["deepseek-v4.1-flash:cloud", "glm-5.1:cloud", "deepseek-v4-flash:cloud"], "in the ranking's own order, not a list below it");
  assert.match(shown, /class="card crow sup" data-key="m:deepseek-v4-flash:cloud"/, "the superseded row is marked");
  assert.ok(shown.includes(">Hide superseded<"));
});

test("a ranking with nothing superseded draws no control", () => {
  const html = loadPerfViews().rankScreen([cell("glm-5.1:cloud", 9), cell("kimi-k3:cloud", 8)], RANK_H);
  assert.ok(!html.includes("data-superseded"), html);
  assert.ok(!html.includes("superseded"), html);
});

// The page can only hide what the server marks: a cell reaching /api/perf
// without `supersededBy` renders beside its replacement however good perf.js is.
async function getPerf({ models = [["deepseek-v4-flash:cloud", 8], ["deepseek-v4.1-flash:cloud", 9]], query = "" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "swarm-rank-"));
  const row = (leaf, model, s) => JSON.stringify({
    resultsDir: "C:/runs/x-1", leaf, model, provider: "ollama", domain: "godot",
    grades: { adherence: s, handoff: s, truthfulness: s, depth: s },
    outcome: "completed", note: "x", assessedBy: { session: "s" },
  });
  const rows = models.flatMap(([model, s], i) => Array.from({ length: 5 }, (_, n) => row(`leaf${i}-${n}`, model, s)));
  writeFileSync(join(home, "model-scores.jsonl"), rows.join("\n") + "\n", "utf8");
  const cfg = { dashboard: { port: 0, bind: "127.0.0.1", token: null }, grading: { enabled: true } };
  const server = createServer({ home, cfg, _estate: estate, _watch: () => ({ close() {} }), _heartbeatMs: 60_000, _pollMs: 60_000 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port: server.address().port, path: `/api/perf${query}` }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(home, { recursive: true, force: true });
  }
}

test("/api/perf marks the superseded overall cell, and the real renderer hides it", async () => {
  const body = await getPerf();
  const old = body.overall.find((c) => c.model === "deepseek-v4-flash:cloud");
  assert.equal(old.supersededBy, "deepseek-v4.1-flash:cloud",
    "RED: the server never read the roster's families, so the page could not hide the row");
  const html = loadPerfViews().rankScreen(body.overall, RANK_H);
  assert.ok(html.includes('data-key="m:deepseek-v4.1-flash:cloud"') && !html.includes('data-key="m:deepseek-v4-flash:cloud"'));
});

// R5: the drill-in rank is a position on the list the ranking SHOWS. A hidden
// superseded model must not inflate a visible model's position or the "of" count.
test("/api/perf ranks a model among the visible cells, not the hidden ones", async () => {
  const model = "deepseek-v4.1-flash:cloud";
  const models = [["deepseek-v4-flash:cloud", 9], ["glm-5.1:cloud", 7], [model, 5]];
  const body = await getPerf({ models });
  assert.equal(body.overall.find((c) => c.model === "deepseek-v4-flash:cloud").supersededBy, model,
    "the top-scoring elder is marked superseded, so the page holds it out of the ranked list");
  const mid = await getPerf({ models, query: `?model=${encodeURIComponent(model)}` });
  assert.deepEqual(mid.rank, { position: 2, of: 2 },
    "the visible list is glm-5.1 then deepseek-v4.1-flash");
});
