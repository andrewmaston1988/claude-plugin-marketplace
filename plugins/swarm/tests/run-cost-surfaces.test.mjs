// One pin per surface on the mixed run (Claude + Codex + :cloud): the CLI footer, the
// closing `tokens:` line, `swarm ask`, the estate row, the run and leaf routes, and the
// three dashboard screens that print what those hand them. Default reads `% of week` alone;
// every dollar figure is behind `display.money`, and none is ever priced from a result file.
import { test } from "node:test";
import { equal, ok, match } from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, runValidated } from "./helpers/cli.mjs";
import { tmp, gateHome } from "./helpers/cli-fixture.mjs";
import { mixedCostHome, PROJECT, NAME, DEFAULT_TEXT, MONEY_TEXT } from "./helpers/mixed-cost-run.mjs";
import { withServer, cfg as dashCfg } from "./helpers/serve-fixture.mjs";
import { buildSnapshot } from "../src/serve/estate.mjs";
import { formatClosing } from "../src/results-render.mjs";
import { loadPage, listData, listRow, targetRun, RUN_URL } from "./helpers/page-harness.mjs";
import { NOW } from "./fixtures/run-fixture.mjs";

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const withHome = async (opts, fn) => {
  const h = mixedCostHome(opts);
  try { return await fn(h); } finally { rmSync(h.home, { recursive: true, force: true }); }
};
const statusOf = (h) => plain(runCli(["status", h.dir], { cwd: h.home, env: { SWARM_HOME: h.home } }).stdout);
const serverCfg = (money) => ({ ...dashCfg(), ...(money && { display: { money: true } }) });

// ── the CLI ─────────────────────────────────────────────────────────────────────

test("status footer: the meter share beside the work tokens, and no dollar sign by default", () => withHome({}, (h) => {
  const out = statusOf(h);
  ok(out.includes(`tokens · ${DEFAULT_TEXT}`), out);
  ok(!out.includes("$"), out);
}));

test("status footer: with display.money the api-equivalent estimate leads the meter share", () => withHome({ money: true }, (h) => {
  const out = statusOf(h);
  ok(out.includes(`tokens · ${MONEY_TEXT}`), out);
}));

test("the closing tokens: line carries the cost text, and nothing when there is none", () => {
  const totalTokens = { input: 100, output: 20, cacheCreation: 0, cacheRead: 0 };
  const base = { summaryPath: "s.json", totalTokens };
  const priced = plain(formatClosing({ ...base, costText: MONEY_TEXT }));
  ok(priced.includes(`tokens: 120 (input 100 · output 20) · ${MONEY_TEXT}`), priced);
  const bare = plain(formatClosing({ ...base, costText: "" }));
  ok(bare.includes("tokens: 120 (input 100 · output 20)") && !bare.includes("·  "), bare);
  equal(plain(formatClosing(base)), bare, "an absent costText reads as an empty one");
});

function shimRun(extraConfig) {
  const dir = tmp();
  try {
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({ resultsDir: "out", tasks: [{ id: "t1", prompt: "x", provider: "claude", model: "claude-haiku-4-5-20251001" }] }));
    const home = join(dir, "home");
    const env = { SWARM_HOME: home, SWARM_SHIM_STREAM: "1", SWARM_SHIM_OUTPUT: "because X" };
    if (extraConfig) gateHome(home, extraConfig);
    const run = runValidated(["run", manifest], { cwd: dir, env });
    equal(run.status, 0, run.stdout + run.stderr);
    const ask = runCli(["ask", join(dir, "out"), "t1", "why?"], { cwd: dir, env });
    equal(ask.status, 0, ask.stdout + ask.stderr);
    return { run: plain(run.stdout), ask: plain(ask.stdout) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("run closing line and swarm ask: no dollar sign anywhere by default", () => {
  const { run, ask } = shimRun(null);
  ok(run.includes("tokens:") && ask.includes("tokens:"));
  ok(!run.includes("$") && !ask.includes("$"), `${run}\n${ask}`);
});

test("run closing line and swarm ask: display.money prints the estimate, labelled api-eq", () => {
  const { run, ask } = shimRun({ display: { money: true } });
  match(run, /tokens: .*≈\$[\d.]+ api-eq/);
  match(ask, /tokens: .*≈\$[\d.]+ api-eq/);
});

// ── the estate and the routes ───────────────────────────────────────────────────

test("estate row: carries each unit priced separately, so the server only formats", () => withHome({}, (h) => {
  const row = buildSnapshot(h.home, new Map(), { now: NOW }).rows.find((r) => r.name === NAME);
  ok(Math.abs(row.cost.usd - 0.67) < 1e-9, JSON.stringify(row.cost));
  equal(row.cost.usdKind, "api-equivalent");
  ok(Math.abs(row.cost.weekPct - 3.2) < 1e-9, JSON.stringify(row.cost));
}));

test("estate row: an unmeasured meter leaves the share blank while the dollars stay", () => withHome({}, (h) => {
  rmSync(join(h.home, "usage-history.jsonl"));
  const row = buildSnapshot(h.home, new Map(), { now: NOW }).rows.find((r) => r.name === NAME);
  ok(row.cost.usd > 0 && row.cost.weekPct === undefined, JSON.stringify(row.cost));
}));

const routes = (h, money, fn) => withServer({ home: h.home, cfg: serverCfg(money) }, async ({ get }) => fn({
  runs: async () => (await get("/api/runs")).body.runs.find((r) => r.name === NAME),
  run: async () => (await get(`/api/runs/${PROJECT}/${NAME}`)).body,
  leaf: async (id) => (await get(`/api/runs/${PROJECT}/${NAME}/leaves/${id}`)).body,
}));

test("routes: the run list and run screen carry the meter share alone by default, and no dollar figure", () => withHome({}, (h) => routes(h, false, async (r) => {
  const row = await r.runs();
  equal(row.costText, DEFAULT_TEXT);
  equal(row.cost, undefined, "no usd reaches the wire without the opt-in");
  const run = await r.run();
  equal(run.costText, DEFAULT_TEXT);
  ok(!JSON.stringify(run).includes('"usd"') && !JSON.stringify(row).includes('"usd"'));
})));

test("routes: with display.money the run list and run screen add the api-equivalent estimate", () => withHome({}, (h) => routes(h, true, async (r) => {
  equal((await r.runs()).costText, MONEY_TEXT);
  equal((await r.run()).costText, MONEY_TEXT);
})));

test("leaf route: priced from the run's own row — the result file's costUsd (2.18, 0.9) is never read", () => withHome({}, (h) => routes(h, false, async (r) => {
  equal((await r.leaf("cloud-leaf")).costText, DEFAULT_TEXT);
  const claude = await r.leaf("claude-leaf");
  ok(!claude.costText, `a subscription leaf has no default figure: ${claude.costText}`);
  ok(!JSON.stringify(claude).includes("$"));
})));

test("leaf route: with display.money a subscription leaf is an estimate from its buckets, not its result costUsd", () => withHome({}, (h) => routes(h, true, async (r) => {
  equal((await r.leaf("claude-leaf")).costText, "≈$0.32 api-eq");
  equal((await r.leaf("codex-leaf")).costText, "≈$0.35 api-eq");
  equal((await r.leaf("cloud-leaf")).costText, DEFAULT_TEXT, "a :cloud leaf never shows dollars");
})));

// ── the dashboard screens print what the server sent ────────────────────────────

const onPage = async (hash, respond) => {
  const P = loadPage();
  await P.flush();
  if (hash) { P.location.hash = hash; P.fireHashchange(); await P.flush(); }
  respond(P);
  await P.flush();
  return P.screenText();
};

test("dashboard run row shows the cost text beside the work tokens", async () => {
  const text = await onPage(null, (P) => P.respondList(listData(listRow({ costText: DEFAULT_TEXT }))));
  ok(text.includes(DEFAULT_TEXT), text);
  const bare = await onPage(null, (P) => P.respondList(listData(listRow())));
  ok(!bare.includes("of week"), "a row with no cost text prints none");
});

test("dashboard run header shows the cost text; the page never adds a figure of its own", async () => {
  const text = await onPage(RUN_URL, (P) => P.respondRun({ ...targetRun(), costText: MONEY_TEXT }));
  ok(text.includes(MONEY_TEXT), text);
  const bare = await onPage(RUN_URL, (P) => P.respondRun(targetRun()));
  ok(!bare.includes("of week") && !bare.includes("api-eq") && !bare.includes("$"), bare);
});

test("dashboard leaf panel shows the cost text on the tokens card", async () => {
  const text = await onPage(`${RUN_URL}/leaf/leaf-a`, (P) => {
    P.respondRun(targetRun());
    P.respondLeaf({ id: "leaf-a", prompt: "p", output: "o", costText: DEFAULT_TEXT });
  });
  ok(text.includes(DEFAULT_TEXT), text);
});
