// Usage, Cost and Performance change gradually: each paints its last reading at once,
// refreshes behind it on its own cadence, and repaints only when the data changed.
// Operator 2026-09-24: "cost is refreshing every 5s or so, it blinks - it shouldn't be a
// full page reload, just the data responsively"; "I'm thinking minutes not seconds";
// "usage, you might want more frequency"; "perf and cost change gradually."
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPage, listData, listRow, targetRun, RUN_URL } from "./helpers/page-harness.mjs";

const isUsage = (u) => u.startsWith("/api/usage");
const COST = { sections: [], tag: "a" };

function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, map: m };
}

async function boot(opts = {}) {
  let now = opts.start ?? 1_000_000_000;
  const renders = { cost: 0, usage: 0 };
  const P = loadPage({
    storage: opts.storage,
    clock: () => now,
    perfViews: {
      costScreen: (d) => { renders.cost++; return `<div class="stub">${d.tag}</div>`; },
      usageScreen: (d) => { renders.usage++; return `<div class="stub">${d.tag}</div>`; },
    },
  });
  await P.flush();
  P.respondList({ ...listData(listRow()), ...opts.list });
  await P.flush();
  return { P, renders, advance: (ms) => { now += ms; }, now: () => now };
}
async function go(P, hash) { P.location.hash = hash; P.fireHashchange(); await P.flush(); }

// currentRun outlives the run screen, and shouldPoll used to read it on any view — so
// after a live run, Cost inherited the run's 5 s full rebuild and /api/cost refetch.
test("Cost issues no refetch on the 5 s poll after a live run was visited", async () => {
  const { P } = await boot();
  await go(P, RUN_URL);
  P.respondRun(targetRun());
  await P.flush();
  await go(P, "#/cost");
  P.respondCost(COST);
  await P.flush();
  const before = P.costFetches().length;
  P.fireTimers(5000);
  await P.flush();
  assert.equal(P.costFetches().length, before);
});

test("a cached Cost reading paints at once, revalidates once, and an unchanged one repaints nothing", async () => {
  const storage = memStorage({ "swarm.cache:/api/cost": JSON.stringify({ data: COST, at: 1_000_000_000 }) });
  const { P, renders } = await boot({ storage });
  await go(P, "#/cost");
  assert.equal(P.findByClass("skeleton").length, 0, "no skeleton when a reading is held");
  assert.equal(P.findByClass("stub")[0].textContent, "a");
  assert.equal(P.costFetches().length, 1, "one revalidate on arrival");
  const painted = renders.cost;
  P.respondCost(COST);
  await P.flush();
  assert.equal(renders.cost, painted, "identical data: no repaint");
});

test("a changed Cost reading repaints exactly once, and is kept for the next load", async () => {
  const storage = memStorage({ "swarm.cache:/api/cost": JSON.stringify({ data: COST, at: 1_000_000_000 }) });
  const { P, renders } = await boot({ storage });
  await go(P, "#/cost");
  const painted = renders.cost;
  P.respondCost({ sections: [], tag: "b" });
  await P.flush();
  await P.flush();
  assert.equal(renders.cost, painted + 1);
  assert.equal(P.findByClass("stub")[0].textContent, "b");
  assert.equal(JSON.parse(storage.map.get("swarm.cache:/api/cost")).data.tag, "b");
});

test("Cost revalidates every 300000 ms by default, not before", async () => {
  const { P, advance } = await boot();
  await go(P, "#/cost");
  P.respondCost(COST);
  await P.flush();
  const n = P.costFetches().length;
  advance(299_999); P.fireTimers(1000); await P.flush();
  assert.equal(P.costFetches().length, n, "inside the cadence");
  advance(1); P.fireTimers(1000); await P.flush();
  assert.equal(P.costFetches().length, n + 1);
});

test("the cadences come from the /api/runs payload", async () => {
  const { P, advance } = await boot({ list: { statsPollMs: 60_000, usagePollMs: 10_000 } });
  await go(P, "#/cost");
  P.respondCost(COST);
  await P.flush();
  const n = P.costFetches().length;
  advance(60_000); P.fireTimers(1000); await P.flush();
  assert.equal(P.costFetches().length, n + 1);
});

test("Usage revalidates every 60000 ms by default", async () => {
  const { P, advance } = await boot();
  await go(P, "#/usage");
  P.respond(isUsage, { usages: [], errors: {}, tag: "u" });
  await P.flush();
  const n = P.fetchLog.filter(isUsage).length;
  advance(59_999); P.fireTimers(1000); await P.flush();
  assert.equal(P.fetchLog.filter(isUsage).length, n);
  advance(1); P.fireTimers(1000); await P.flush();
  assert.equal(P.fetchLog.filter(isUsage).length, n + 1);
});
