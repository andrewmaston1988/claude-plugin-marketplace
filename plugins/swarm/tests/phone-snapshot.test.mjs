// Every phone screen's markup, pinned: the desktop work moves render helpers out of
// page.html and splits perf.js, and each move must leave the phone byte-identical.
// SWARM_UPDATE_SNAPSHOTS=1 rewrites the golden file; review its diff like code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { loadPage, serialize, RUN_URL } from "./helpers/page-harness.mjs";

const GOLDEN = new URL("./fixtures/phone-snapshots.json", import.meta.url);
const T = 1_790_000_000_000;

const live = { project: "C--code-listproj", group: "C--code-listproj", name: "LIVERUN", groupLabel: "list-label", active: true,
  startedMs: T - 95_000, mtimeMs: T - 2_000, finishedMs: null, byState: { running: 1, ok: 2 }, leaves: 3, waves: 2, tokens: 48_200,
  providerTokens: { ollama: 30_000, codex: 18_200 }, providersRunning: ["ollama"] };
const done = { ...live, name: "DONERUN", active: false, startedMs: T - 7_200_000, mtimeMs: T - 3_600_000, finishedMs: T - 3_600_000,
  byState: { ok: 3, failed: 1 }, leaves: 4, waves: 2, tokens: 1_204_000, providersRunning: [] };
const list = { clockMs: 1000, uiPollMs: 5000, grading: true, finishedTotals: { "C--code-listproj": 1 }, runs: [live, done] };

const run = { project: "C--code-tgt", name: "TARGETRUN", groupLabel: "tgt", startedMs: T - 600_000, finishedMs: T - 60_000,
  abortedMs: null, stoppedMs: null, quietWarnMs: 60_000, totals: { byState: { ok: 2, failed: 1 } },
  tasks: [
    { id: "find", state: "ok", provider: "ollama", model: "glm-5.2:cloud", tokens: { input: 1200, output: 340 }, durationMs: 125_000, after: [] },
    { id: "check", state: "failed", provider: "codex", model: "gpt-6-luna", tokens: { input: 800, output: 90 }, durationMs: 61_000, after: ["find"] },
    { id: "impl", state: "ok", provider: "claude", model: "claude-sonnet-5", tokens: { input: 5000, output: 2100 }, durationMs: 300_000, after: ["find"] },
    { id: "sub", kind: "manifest", state: "ok", tokens: { input: 900, output: 100 }, after: ["impl"] },
    { id: "sub/a", kind: "child", parent: "sub", depth: 1, state: "ok", provider: "ollama", model: "glm-5.2:cloud", tokens: { input: 400, output: 50 }, durationMs: 40_000, after: [] },
    { id: "sub/b", kind: "child", parent: "sub", depth: 2, state: "ok", provider: "ollama", model: "kimi", tokens: { input: 500, output: 50 }, durationMs: 30_000, after: ["sub/a"] },
  ],
  waves: [["find"], ["check", "impl"], ["sub"]] };
const leaf = { id: "impl", prompt: "do the thing", output: "did the thing" };

const lim = (kind, percent, over = {}) => ({ kind, percent, resetsAt: null, scope: null, window: null, ...over });
const usage = { usages: [
  { provider: "anthropic", state: "ok", provenance: "live", limits: [lim("session", 3), lim("weekly_all", 88)] },
  { provider: "ollama", state: "ok", provenance: "live", limits: [lim("session", 37.1), lim("weekly", 28.3)] },
], errors: {} };

const srow = (model, mult) => ({ model, mult, band: 1, requests: 500, measuredRequests: 500, weeks: 3, measuredWeeks: 3, thin: false });
const point = (model, wtd, multiplier, over = {}) => ({ model, wtd, n: 6, multiplier, band: 1, onFrontier: false, dominatedBy: null, thin: false, ...over });
const cost = { sections: [
  { provider: "ollama", spread: [srow("glm-5.2:cloud", 1), srow("kimi", 3)], points: [point("glm-5.2:cloud", 8, 1, { onFrontier: true }), point("kimi", 4, 3, { dominatedBy: "glm-5.2:cloud" })],
    best: point("glm-5.2:cloud", 8, 1, { onFrontier: true }), worst: point("kimi", 4, 3, { dominatedBy: "glm-5.2:cloud" }) },
  { provider: "claude", spread: [srow("claude-sonnet-5", 2)], points: [], best: null, worst: null },
] };

const cell = (model, combined, n) => ({ model, combined, n, provisional: n < 20, outcomes: { completed: n },
  wtds: { adherence: combined, handoff: combined, truthfulness: combined, depth: combined } });
const perf = (rank) => ({ grading: true, path: "x", lines: 2, rows: 2, priorWeight: 4, aspects: ["code"],
  universals: ["adherence", "handoff", "truthfulness", "depth"], domains: ["node"], filters: { aspect: null, model: null, domain: null },
  overall: [cell("m-dear", 7.9, 26), cell("glm-5.2:cloud", 7.4, 12), cell("claude-sonnet-5", 7.2, 2)],
  report: [{ aspect: "code", universal: false, cells: [{ model: "m-dear", weighted: 8.1, mean: 8.3, n: 26, provisional: false },
    { model: "glm-5.2:cloud", weighted: 7.6, mean: 7.9, n: 3, provisional: true }] }], ...(rank ? { rank } : {}),
  views: {
    coverage: { aspects: ["code", "depth"], models: ["m-dear", "glm-5.2:cloud"],
      cells: [{ model: "m-dear", aspect: "code", n: 26, provisional: false }, { model: "glm-5.2:cloud", aspect: "code", n: 3, provisional: true }] },
    reliability: [{ model: "m-dear", total: 26, byOutcome: { completed: 24, failed: 2 } }, { model: "glm-5.2:cloud", total: 12, byOutcome: { completed: 11, timeout: 1 } }],
    leaders: [{ aspect: "code", top: [{ model: "m-dear", weighted: 8.1, n: 26, provisional: false }, { model: "glm-5.2:cloud", weighted: 7.6, n: 3, provisional: true },
      { model: "claude-sonnet-5", weighted: 7.0, n: 2, provisional: true }] }, { aspect: "vision", top: [] }],
    cost: { bands: [2, 5], points: [point("m-dear", 7.9, 4.4, { band: 2, coins: 2, onFrontier: true }), point("glm-5.2:cloud", 7.4, 1, { coins: 1 })],
      spread: [{ ...srow("claude-sonnet-5", 2), coins: 2 }],
      sections: [{ provider: "ollama", best: point("glm-5.2:cloud", 7.4, 1), worst: null }] } } });

const FIXTURES = [
  [(u) => /^\/api\/runs(\?|$)/.test(u), () => list],
  [(u) => /\/leaves\//.test(u), () => leaf],
  [(u) => /^\/api\/runs\/[^/]+\/[^/?]+(\?|$)/.test(u), () => run],
  [(u) => u.startsWith("/api/usage"), () => usage],
  [(u) => u.startsWith("/api/cost"), () => cost],
  [(u) => u.startsWith("/api/perf"), (u) => perf(u.includes("model=") ? { position: 2, of: 3 } : null)],
];

// Answer every pending fetch from the fixture table until the page stops asking.
async function settle(P) {
  for (let round = 0; round < 10; round++) {
    await P.flush();
    const urls = P.pendingUrls();
    if (!urls.length) return;
    for (const url of urls) {
      const hit = FIXTURES.find(([pred]) => pred(url));
      assert.ok(hit, `no fixture for ${url}`);
      P.respond((u) => u === url, hit[1](url));
    }
  }
  assert.fail(`fetches never settled: ${P.pendingUrls().join(", ")}`);
}

async function screen(hash, before) {
  const P = loadPage({ clock: () => T });
  await settle(P);
  if (before) { before(P); await settle(P); }
  if (hash) { P.location.hash = hash; P.fireHashchange(); await settle(P); }
  return `${serialize(P.hdr)}\n${serialize(P.main)}`;
}

const SCREENS = {
  runs: () => screen(null, (P) => P.tap(P.findByClass("section").find((e) => e.getAttribute("data-project")))),
  run: () => screen(RUN_URL),
  leaf: () => screen(`${RUN_URL}/leaf/impl`),
  node: () => screen(`${RUN_URL}/node/sub`),
  "usage week": () => screen("#/usage"),
  "usage session": () => screen("#/usage/session"),
  cost: () => screen("#/cost"),
  "cost claude": () => screen("#/cost/claude"),
  "perf rank": () => screen("#/perf"),
  "perf leaders": () => screen("#/perf/leaders"),
  "perf coverage": () => screen("#/perf/coverage"),
  "perf reliability": () => screen("#/perf/reliability"),
  "perf aspect": () => screen("#/perf/aspect/code"),
  "perf model": () => screen("#/perf/model/glm-5.2%3Acloud"),
};

test("every phone screen renders byte-identical markup to the golden file", async () => {
  const got = {};
  for (const [name, render] of Object.entries(SCREENS)) got[name] = await render();
  if (process.env.SWARM_UPDATE_SNAPSHOTS === "1") {
    writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + "\n");
    return;
  }
  const want = JSON.parse(readFileSync(GOLDEN, "utf8"));
  assert.deepEqual(Object.keys(got), Object.keys(want), "the screen set changed");
  for (const name of Object.keys(want)) assert.equal(got[name], want[name], `${name} screen markup changed`);
});
