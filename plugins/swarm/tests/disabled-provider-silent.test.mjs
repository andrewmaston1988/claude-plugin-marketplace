// A provider that is not enabled in config is never contacted and never listed:
// no request to its vendor (not even a DNS lookup, so the gate sits before any
// request is built), no cost row or section, no price card. Grading off is never
// shown as "not graded yet". Every test drives a real entry point.
import { test } from "node:test";
import { deepEqual, equal, ok, throws, rejects } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { enabledProviderIds } from "../src/providers.mjs";
import { defaultProviderRegistry } from "../src/default-providers.mjs";
import { refreshRateCards } from "../src/rate-card.mjs";
import { refreshPrices, refreshStaleRateCards } from "../src/rate-card-cli.mjs";
import { costSections } from "../src/cost.mjs";
import { createServer } from "../src/serve/server.mjs";
import { runCli } from "./helpers/cli.mjs";
import { loadPerfViews, H } from "./helpers/perf-views-harness.mjs";

const RECORD = new URL("./helpers/record-fetch.mjs", import.meta.url).href;
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const OPENAI = "openai.com";
const CLAUDE_HOSTS = /anthropic\.com|claude\.com/;

// Vendor pages from the saved fixtures, every URL recorded.
const recorder = () => {
  const urls = [];
  const _fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, text: async () => fixture(url.includes("openai") ? "openai-pricing.md" : "anthropic-pricing.md") };
  };
  return { urls, _fetch };
};
const sink = () => { const lines = []; const fn = (l) => lines.push(l); fn.lines = lines; return fn; };
const storePath = () => join(mkdtempSync(join(tmpdir(), "swarm-silent-")), "rate-cards.json");
const cfgWith = (on) => ({ providers: Object.fromEntries(["claude", "ollama", "codex"].map((id) => [id, { enabled: on.includes(id) }])) });
const registry = defaultProviderRegistry();

// ── the predicate ───────────────────────────────────────────────────────────
test("enabledProviderIds: the registry's own enabled flag", () => {
  deepEqual(enabledProviderIds(cfgWith(["claude", "ollama"]), registry).sort(), ["claude", "ollama"]);
  deepEqual(enabledProviderIds(cfgWith(["codex"]), registry), ["codex"]);
  deepEqual(enabledProviderIds(cfgWith([]), registry), []);
});

test("enabledProviderIds: the registry is required — a default would hide a caller that forgot it", () => {
  throws(() => enabledProviderIds(cfgWith(["codex"])), TypeError);
});

// ── the price refresh, in process ───────────────────────────────────────────
test("refreshRateCards: the provider list is required — no default of every vendor", async () => {
  const { urls, _fetch } = recorder();
  await rejects(refreshRateCards({ path: storePath(), _fetch }), TypeError);
  deepEqual(urls, [], "an omitted list must not fall back to fetching every vendor");
});

test("refresh-prices (dry run and real): a disabled provider's page is never fetched", async () => {
  for (const dryRun of [true, false]) {
    const { urls, _fetch } = recorder();
    equal(await refreshPrices({ out: sink(), err: sink(), dryRun, path: storePath(), _fetch, enabled: ["claude", "ollama"] }), 0);
    ok(urls.length > 0 && urls.every((u) => CLAUDE_HOSTS.test(u)), `dryRun=${dryRun}: only claude's page, saw ${urls}`);
    ok(!urls.some((u) => u.includes(OPENAI)), `dryRun=${dryRun}: codex is disabled, saw ${urls}`);
  }
});

test("refresh-prices with every rate-card vendor disabled fetches nothing and names no vendor", async () => {
  for (const dryRun of [true, false]) {
    const { urls, _fetch } = recorder();
    const out = sink(), err = sink();
    equal(await refreshPrices({ out, err, dryRun, path: storePath(), _fetch, enabled: ["ollama"] }), 0);
    deepEqual(urls, []);
    ok(!/codex|claude|openai|anthropic/i.test([...out.lines, ...err.lines].join("\n")), `output named a disabled vendor: ${out.lines}`);
  }
});

test("refresh-prices still refreshes codex's page when codex is enabled", async () => {
  for (const dryRun of [true, false]) {
    const { urls, _fetch } = recorder();
    await refreshPrices({ out: sink(), err: sink(), dryRun, path: storePath(), _fetch, enabled: ["codex"] });
    ok(urls.some((u) => u.includes(OPENAI)), `dryRun=${dryRun}: codex is enabled, saw ${urls}`);
    ok(!urls.some((u) => CLAUDE_HOSTS.test(u)), `dryRun=${dryRun}: claude is disabled, saw ${urls}`);
  }
});

test("the stale-card refresh (what `swarm cost` and the dashboard run) fetches only enabled vendors", async () => {
  const cases = [
    { enabled: ["claude", "ollama"], has: [CLAUDE_HOSTS], lacks: [/openai\.com/] },
    { enabled: ["codex"], has: [/openai\.com/], lacks: [CLAUDE_HOSTS] },
    { enabled: ["ollama"], has: [], lacks: [/openai\.com/, CLAUDE_HOSTS] },
  ];
  for (const { enabled, has, lacks } of cases) {
    const { urls, _fetch } = recorder();
    // No banked store: the seeds are past their window, so every enabled card is stale.
    await refreshStaleRateCards({ out: sink(), err: sink(), path: storePath(), _fetch, now: Date.parse("2026-10-05T00:00:00Z"), enabled });
    for (const re of has) ok(urls.some((u) => re.test(u)), `${enabled}: expected ${re}, saw ${urls}`);
    for (const re of lacks) ok(!urls.some((u) => re.test(u)), `${enabled}: ${re} is disabled, saw ${urls}`);
  }
});

// ── the real CLI, with every fetch recorded ─────────────────────────────────
function cli(args, on) {
  const dir = mkdtempSync(join(tmpdir(), "swarm-silent-cli-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify(cfgWith(on)));
  const log = join(dir, "fetches.log");
  writeFileSync(log, "");
  try {
    const r = runCli(args, { cwd: dir, env: { SWARM_HOME: home, SWARM_FETCH_LOG: log, NODE_OPTIONS: `--import=${RECORD}` } });
    const urls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    return { ...r, urls, text: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("`swarm cost`, `refresh-prices` and `--dry-run` with codex disabled request no openai.com URL", () => {
  for (const args of [["cost"], ["refresh-prices"], ["refresh-prices", "--dry-run"]]) {
    const r = cli(args, ["claude", "ollama"]);
    ok(!r.urls.some((u) => u.includes(OPENAI)), `${args.join(" ")}: codex disabled, but requested ${r.urls}`);
    ok(r.urls.some((u) => CLAUDE_HOSTS.test(u)), `${args.join(" ")}: claude is enabled and its page must still be read, saw ${r.urls}\n${r.text}`);
  }
});

test("with codex AND claude disabled, no vendor URL is requested at all", () => {
  for (const args of [["cost"], ["refresh-prices"], ["refresh-prices", "--dry-run"]]) {
    const r = cli(args, ["ollama"]);
    deepEqual(r.urls, [], `${args.join(" ")} reached a vendor with both disabled`);
  }
});

test("with codex enabled, `swarm cost` still refreshes its pricing page", () => {
  const r = cli(["cost"], ["codex"]);
  ok(r.urls.some((u) => u.includes(OPENAI)), `codex enabled but never fetched: ${r.urls}\n${r.text}`);
});

test("`swarm cost` prints a section only for enabled providers", () => {
  const r = cli(["cost"], ["claude", "ollama"]);
  ok(/── claude /.test(r.stdout), r.text);
  ok(!/codex|gpt-/i.test(r.text), `codex is disabled but the cost output names it:\n${r.text}`);
  const only = cli(["cost"], ["codex"]);
  ok(/── codex /.test(only.stdout), only.text);
  ok(!/claude/i.test(only.text), `only codex is enabled but the cost output names claude:\n${only.text}`);
});

// ── the cost lists ──────────────────────────────────────────────────────────
test("costSections: the provider list is required — no default of every card", () => {
  throws(() => costSections({ models: {} }), TypeError);
  deepEqual(costSections({ providers: ["claude"] }).map((s) => s.provider), ["claude"]);
});

const estate = { current: () => Promise.resolve({ version: 0, runs: [] }), refresh() {}, onSnapshot() {}, close() {} };

async function getCost(cfg, refreshLog) {
  const home = mkdtempSync(join(tmpdir(), "swarm-silent-srv-"));
  const server = createServer({
    home, cfg: { dashboard: { port: 0, bind: "127.0.0.1", token: null }, ...cfg }, _estate: estate,
    _watch: () => ({ close() {} }), _heartbeatMs: 60_000, _pollMs: 60_000,
    // The dashboard's own refresh, its network swapped for the recorder.
    _refreshPrices: (opts) => refreshStaleRateCards({ ...opts, _fetch: refreshLog._fetch }),
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const body = await new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port: server.address().port, path: "/api/cost" }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve(JSON.parse(text)));
    }).on("error", reject));
    await new Promise((r) => setTimeout(r, 50)); // the refresh is fire-and-forget off the request path
    return body;
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(home, { recursive: true, force: true });
  }
}

test("/api/cost with codex disabled carries no codex section and the dashboard fetches no openai.com", async () => {
  const rec = recorder();
  const body = await getCost({ ...cfgWith(["claude", "ollama"]), grading: { enabled: true } }, rec);
  ok(body.sections.some((s) => s.provider === "claude"), "an enabled provider keeps its section");
  ok(!body.sections.some((s) => s.provider === "codex"), "no codex section");
  ok(!/codex|gpt-/i.test(JSON.stringify(body)), "nothing in the payload names codex or a gpt model");
  ok(!rec.urls.some((u) => u.includes(OPENAI)), `the dashboard's price refresh reached codex's vendor: ${rec.urls}`);
});

test("/api/cost with only codex enabled carries no claude section and no anthropic request", async () => {
  const rec = recorder();
  const body = await getCost({ ...cfgWith(["codex"]), grading: { enabled: true } }, rec);
  ok(body.sections.some((s) => s.provider === "codex"));
  ok(!/claude|anthropic/i.test(JSON.stringify(body)), "nothing in the payload names claude");
  ok(!rec.urls.some((u) => CLAUDE_HOSTS.test(u)), `reached claude's vendor: ${rec.urls}`);
});

test("the cost page, fed a codex-free payload, draws no codex text or logo", async () => {
  const body = await getCost({ ...cfgWith(["claude", "ollama"]), grading: { enabled: true } }, recorder());
  const html = loadPerfViews().costAll(body, H);
  ok(!/codex|gpt-/i.test(html), "the rendered cost page names codex");
});

// ── grading off ─────────────────────────────────────────────────────────────
test("/api/cost says whether grading is enabled", async () => {
  equal((await getCost({ ...cfgWith(["claude"]), grading: { enabled: false } }, recorder())).grading, false);
  equal((await getCost({ ...cfgWith(["claude"]), grading: { enabled: true } }, recorder())).grading, true);
});

const point = (model) => ({ model, wtd: null, n: 0, multiplier: 1, band: 1, onFrontier: false, dominatedBy: null, thin: false });
const priced = (grading) => ({
  grading,
  sections: [{
    provider: "claude", points: [point("claude-sonnet-5")], best: null, worst: null,
    spread: [{ model: "claude-sonnet-5", mult: 1, band: 1, requests: 1, measuredRequests: 1, weeks: 1, measuredWeeks: 1, thin: false }],
  }],
});

test("grading off: the cost page draws no best-value card and no 'not graded yet' — the prices stay", () => {
  const V = loadPerfViews();
  for (const draw of [(d) => V.costScreen(d, H), (d) => V.costAll(d, H)]) {
    const html = draw(priced(false));
    ok(!html.includes("not graded yet"), "grading off is not 'not graded yet'");
    ok(!html.includes("chero"), "no value hero without grades");
    ok(html.includes("claude-sonnet-5") && html.includes("1×"), "the price list still draws");
  }
});

test("grading on with no grades still says 'not graded yet'", () => {
  const html = loadPerfViews().costScreen(priced(true), H);
  ok(html.includes("not graded yet") && html.includes("chero"));
});
