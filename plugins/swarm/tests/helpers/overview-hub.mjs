import assert from "node:assert/strict";
import { loadPage, listData, listRow, serialize } from "./page-harness.mjs";

// The Overview hub's fixtures and boot helpers, shared by its test files.
export const T = 1_790_000_000_000;
export const live = (name) => listRow({ name, startedMs: T - 60_000, mtimeMs: T - 1_000 });
export const finished = (name, n) => listRow({
  name, active: false, startedMs: T - (n + 2) * 60_000, mtimeMs: T - n * 60_000,
  finishedMs: T - n * 60_000, byState: { ok: 1 },
});
export const RUNS = { ...listData(live("LIVE_A")), runs: [
  live("LIVE_A"), live("LIVE_B"), ...Array.from({ length: 6 }, (_, i) => finished("DONE_" + (i + 1), i + 1)),
] };
export const USAGE = { usages: [
  { provider: "anthropic", state: "ok", provenance: "live", limits: [{ kind: "weekly_all", percent: 12 }] },
  { provider: "ollama", state: "ok", provenance: "live", limits: [{ kind: "weekly", percent: 30 }] },
], errors: { codex: "not read" } };
export const point = (model, wtd, multiplier) => ({ model, wtd, multiplier, n: 8, onFrontier: true });
// The payload the hub no longer has any part of — kept whole so a stray read would draw
// a real top-models list rather than crash, and the fetchLog assertion is the one that bites.
export const PERF = { grading: true, rows: 20, overall: [], domains: [], aspects: [], views: {
  leaders: [{ aspect: "code", top: [
    { model: "model-alpha", weighted: 8.1, n: 12, provisional: false },
    { model: "model-beta", weighted: 7.3, n: 4, provisional: true },
  ] }],
} };
export const COST = { sections: [
  { provider: "ollama", points: [point("model-alpha", 8.1, 1)], spread: [{ model: "model-alpha", mult: 1 }], best: point("model-alpha", 8.1, 1) },
  { provider: "claude", points: [point("model-gamma", 7.6, 2)], spread: [{ model: "model-gamma", mult: 2 }], best: point("model-gamma", 7.6, 2) },
] };
// The run a hub row opens: the run screen's own payload shape, two leaves in two waves.
export const runPayload = (name) => ({
  project: "C--code-listproj", name, groupLabel: "list-label",
  startedMs: T - 300_000, finishedMs: T - 60_000, abortedMs: null, stoppedMs: null, quietWarnMs: 60_000,
  totals: { byState: { ok: 1, failed: 1 } },
  tasks: [
    { id: "leaf-a", state: "ok", model: "glm", tokens: { input: 10, output: 20 }, after: [] },
    { id: "leaf-b", state: "failed", model: "gpt-6-luna", tokens: { input: 5, output: 5 }, after: ["leaf-a"] },
  ],
  waves: [["leaf-a"], ["leaf-b"]],
});
export const OPENED = "C--code-listproj/DONE_2";
export const OPENED_URL = "/api/runs/C--code-listproj/DONE_2";
export const isRunUrl = (u) => /^\/api\/runs\/[^/]+\/[^/?]+/.test(u);

// An in-memory localStorage: the same object handed to two boots is the same storage,
// which is what "the state survives a reload" means in a harness with no browser.
export function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

export function replies({ usage = USAGE, cost = COST, run = null } = {}) {
  const table = [
    [(u) => /^\/api\/runs(\?|$)/.test(u), RUNS],
    [(u) => u === "/api/usage", usage],
    [(u) => u === "/api/cost", cost],
    // Answered, not expected: the hub is claiming it never asks, and that claim is made
    // by its own test against fetchLog — here the read is served so a boot that does ask
    // fails on what it drew rather than on every test dying at the same request.
    [(u) => u.startsWith("/api/perf"), PERF],
  ];
  if (run) table.push([isRunUrl, run]);
  return table;
}

export async function settle(P, table = replies(), fail = []) {
  for (let n = 0; n < 8; n++) {
    await P.flush();
    const urls = P.pendingUrls();
    if (!urls.length) return;
    for (const url of urls) {
      if (fail.some((re) => re.test(url))) { P.fail((u) => u === url); continue; }
      const reply = table.find(([matches]) => matches(url));
      assert.ok(reply, "unexpected request: " + url);
      P.respond((u) => u === url, reply[1]);
    }
  }
  assert.fail("requests did not settle: " + P.pendingUrls().join(", "));
}

// A hub boot: the desktop layout, its own reply table, and the sources a test wants to
// fail. `failPerfJs` boots with no perf.js at all.
export async function hub({ usage = USAGE, cost = COST, run = null, fail = [], failPerfJs = false, storage } = {}) {
  const P = loadPage({ layout: "desktop", clock: () => T, failPerfJs, storage });
  await settle(P, replies({ usage, cost, run }), fail);
  assert.equal(P.location.hash, "#/overview");
  return P;
}

export const overview = () => hub();

export async function sourceScreen(P, hash) {
  P.location.hash = hash;
  P.fireHashchange();
  await settle(P, replies({ run: runPayload("DONE_2") }));
}

export const markup = (P, cls) => P.findByClass(cls).map(serialize);
export const keys = (P, cls) => P.findByClass(cls).map((e) => e.getAttribute("data-key"));
export const finishedRows = (P) => P.findByClass("row").filter((e) => e.getAttribute("data-key").startsWith("C--code-listproj/"));
export const rowNamed = (P, name) => finishedRows(P).find((e) => e.getAttribute("data-key").endsWith("/" + name));
