import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPage, listData, listRow, serialize } from "./helpers/page-harness.mjs";

const T = 1_790_000_000_000;
const live = (name) => listRow({ name, startedMs: T - 60_000, mtimeMs: T - 1_000 });
const finished = (name, n) => listRow({
  name, active: false, startedMs: T - (n + 2) * 60_000, mtimeMs: T - n * 60_000,
  finishedMs: T - n * 60_000, byState: { ok: 1 },
});
const RUNS = { ...listData(live("LIVE_A")), runs: [
  live("LIVE_A"), live("LIVE_B"), ...Array.from({ length: 6 }, (_, i) => finished("DONE_" + (i + 1), i + 1)),
] };
const USAGE = { usages: [
  { provider: "anthropic", state: "ok", provenance: "live", limits: [{ kind: "weekly_all", percent: 12 }] },
  { provider: "ollama", state: "ok", provenance: "live", limits: [{ kind: "weekly", percent: 30 }] },
], errors: { codex: "not read" } };
const PERF = { grading: true, rows: 20, overall: [], domains: [], aspects: [], views: {
  leaders: [{ aspect: "code", top: [
    { model: "model-alpha", weighted: 8.1, n: 12, provisional: false },
    { model: "model-beta", weighted: 7.3, n: 4, provisional: true },
  ] }],
} };
const point = (model, wtd, multiplier) => ({ model, wtd, multiplier, n: 8, onFrontier: true });
const COST = { sections: [
  { provider: "ollama", points: [point("model-alpha", 8.1, 1)], spread: [{ model: "model-alpha", mult: 1 }], best: point("model-alpha", 8.1, 1) },
  { provider: "claude", points: [point("model-gamma", 7.6, 2)], spread: [{ model: "model-gamma", mult: 2 }], best: point("model-gamma", 7.6, 2) },
] };
const replies = [
  [(u) => /^\/api\/runs(\?|$)/.test(u), RUNS],
  [(u) => u === "/api/usage", USAGE],
  [(u) => u === "/api/perf", PERF],
  [(u) => u === "/api/cost", COST],
];

async function settle(P) {
  for (let n = 0; n < 8; n++) {
    await P.flush();
    const urls = P.pendingUrls();
    if (!urls.length) return;
    for (const url of urls) {
      const reply = replies.find(([matches]) => matches(url));
      assert.ok(reply, "unexpected request: " + url);
      P.respond((u) => u === url, reply[1]);
    }
  }
  assert.fail("requests did not settle: " + P.pendingUrls().join(", "));
}

async function overview() {
  const P = loadPage({ layout: "desktop", clock: () => T });
  await settle(P);
  assert.equal(P.location.hash, "#/overview");
  return P;
}

async function sourceScreen(P, hash) {
  P.location.hash = hash;
  P.fireHashchange();
  await settle(P);
}

const markup = (P, cls) => P.findByClass(cls).map(serialize);
const keys = (P, cls) => P.findByClass(cls).map((e) => e.getAttribute("data-key"));

test("Overview reuses live run cards and caps finished runs at five", async () => {
  const P = await overview();
  assert.equal(P.findByClass("rcard").length, 2, "Overview shows both live runs as cards");
  assert.deepEqual(keys(P, "rcard"), ["C--code-listproj/LIVE_A", "C--code-listproj/LIVE_B"]);
  const done = P.findByClass("row").filter((e) => e.getAttribute("data-href").startsWith("#/run/"));
  assert.equal(done.length, 5, "Overview shows the first five finished runs");
  assert.deepEqual(done.map((e) => e.getAttribute("data-key")),
    Array.from({ length: 5 }, (_, i) => "C--code-listproj/DONE_" + (i + 1)));
  const cards = markup(P, "rcard");
  await sourceScreen(P, "#/");
  assert.deepEqual(cards, markup(P, "rcard"), "live cards use the Runs markup");
});

test("Overview fetches Usage and draws its existing hero and one card per provider", async () => {
  const P = await overview();
  assert.equal(P.findByClass("uhero").length, 1, "Overview draws the Usage hero");
  assert.equal(P.findByClass("upc").length, 3, "two readings and one unread provider");
  assert.deepEqual(P.fetchLog.filter((u) => u === "/api/usage"), ["/api/usage"]);
  assert.match(P.findByClass("uhero")[0].textContent, /MOST LEFT THIS WEEK/);
});

test("Overview fetches Performance and draws the top-models list", async () => {
  const P = await overview();
  assert.equal(P.findByClass("rlist").length, 1, "Overview draws leadersList");
  assert.deepEqual(P.findByClass("rlist")[0].textContent.match(/model-(alpha|beta)/g), ["model-alpha", "model-beta"]);
  assert.deepEqual(P.fetchLog.filter((u) => u.startsWith("/api/perf")), ["/api/perf"],
    "Overview requests the unfiltered Performance payload");
});

test("Overview fetches Cost and draws one best-value hero per provider, without model cards", async () => {
  const P = await overview();
  assert.equal(P.findByClass("chero").length, 2, "one costSection hero per provider");
  assert.equal(P.findByClass("cfact").length, 0, "no costSection fact cards");
  assert.equal(P.findByClass("crow").length, 2, "only the two Performance leaders are model cards");
  assert.deepEqual(P.fetchLog.filter((u) => u === "/api/cost"), ["/api/cost"]);
});

test("Overview's figures are the same markup as their phone source parts", async () => {
  const P = await overview();
  assert.equal(P.findByClass("uhero").length, 1, "Overview has a source Usage hero to compare");
  const overviewHero = markup(P, "uhero");
  const overviewCards = markup(P, "upc");
  const overviewLeaders = markup(P, "crow");
  const overviewCosts = markup(P, "chero");
  const phone = loadPage({ clock: () => T });
  await settle(phone);
  await sourceScreen(phone, "#/usage");
  assert.deepEqual(overviewHero, markup(phone, "uhero"), "the hero keeps Usage's figures");
  assert.deepEqual(overviewCards, markup(phone, "upc"), "provider cards keep Usage's figures");
  await sourceScreen(phone, "#/perf/leaders");
  assert.deepEqual(overviewLeaders, markup(phone, "crow"), "top models keep Performance's figures");
  await sourceScreen(phone, "#/cost/ollama");
  const ollama = markup(phone, "chero")[0];
  await sourceScreen(phone, "#/cost/claude");
  assert.deepEqual(overviewCosts, [ollama, markup(phone, "chero")[0]], "value cards keep Cost's figures");
});
