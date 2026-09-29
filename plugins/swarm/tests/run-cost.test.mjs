// Each Goal-table row of swarm-token-headline-cost: a leaf is priced in its own unit beside
// its work tokens, money is opt-in, and the units are never summed. The surfaces that print
// the figure are pinned in run-cost-surfaces.test.mjs.
import { test } from "node:test";
import { deepEqual, equal, ok, throws, match } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { leafCost, runCost, formatCost, costDeps } from "../src/run-cost.mjs";
import { snap, seg } from "./helpers/cost-snapshots.mjs";
import { loadConfig } from "../src/config.mjs";
import { diffPrices } from "../src/rate-card.mjs";
import { parseOpenAiPricing, parseAnthropicPricing } from "../src/rate-card-parse.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const deps = {
  cards: {
    claude: { prices: { "claude-haiku-4-5-20251001": { input: 1, cachedInput: 0.1, output: 5, cacheWrite: 1.25 } } },
    codex: { prices: { "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 } } },
  },
  meterRows: [
    { provider: "ollama", model: "glm-5.3:cloud", ptsPerReq: 0.1 },
    { provider: "ollama", model: "unmeasured:cloud", ptsPerReq: null },
  ],
};
const tokens = (input, cacheCreation, cacheRead, output) => ({ input, cacheCreation, cacheRead, output });

const claude = { provider: "claude", model: "claude-haiku-4-5-20251001", tokens: tokens(100_000, 80_000, 1_000_000, 24_000) };
const codex = { provider: "codex", model: "gpt-6-luna", tokens: tokens(1_000_000, 0, 5_000_000, 400_000) };
const cloud = { provider: "ollama", model: "glm-5.3:cloud", tokens: tokens(500_000, 0, 0, 10_000), numTurns: 32 };

const near = (actual, expected) => ok(Math.abs(actual - expected) < 1e-9, `${actual} !~ ${expected}`);

// ── leafCost: one branch per Goal-table row ─────────────────────────────────────

test("leafCost: a real-key leaf's summary costUsd is the billed figure", () => {
  deepEqual(leafCost({ ...claude, costUsd: 0.42 }, deps), { usd: 0.42, usdKind: "billed" });
});

test("leafCost: a rate-carded Claude leaf is priced from all four buckets, cache writes at the write price", () => {
  const c = leafCost(claude, deps);
  equal(c.usdKind, "api-equivalent");
  near(c.usd, 0.42); // 0.1 + 80k x 1.25 + 0.1 + 0.12
  equal(c.weekPct, undefined);
});

test("leafCost: a card without a write price bills cache creation at input", () => {
  const bare = { claude: { prices: { "claude-haiku-4-5-20251001": { input: 1, cachedInput: 0.1, output: 5 } } } };
  near(leafCost(claude, { ...deps, cards: bare }).usd, 0.4); // 80k x 1 = 0.08
});

test("leafCost: a rate-carded Codex leaf is priced from its own card", () => {
  const c = leafCost(codex, deps);
  equal(c.usdKind, "api-equivalent");
  near(c.usd, 0.35);
});

test("leafCost: a dated id resolves to the card's undated row", () => {
  const dated = { ...codex, provider: "claude", model: "claude-haiku-4-5-20251001-20260101" };
  ok(leafCost(dated, deps).usd > 0);
});

test("leafCost: a :cloud leaf is requests x points-per-request, never dollars", () => {
  const c = leafCost(cloud, deps);
  near(c.weekPct, 3.2);
  equal(c.usd, undefined);
  equal(c.usdKind, undefined);
});

test("leafCost: a :cloud leaf's costUsd is ignored — the Claude runner prices it at Anthropic rates", () => {
  deepEqual(leafCost({ ...cloud, costUsd: 2.18 }, deps), leafCost(cloud, deps));
});

test("leafCost: unknown is blank, never zero", () => {
  deepEqual(leafCost({ ...claude, model: "claude-sonnet-9" }, deps), {}, "an unpriced model");
  deepEqual(leafCost({ ...codex, provider: "unheard-of" }, deps), {}, "a provider with no card");
  const { numTurns: _n, ...noTurns } = cloud;
  deepEqual(leafCost(noTurns, deps), {}, "an old run without request counts");
  deepEqual(leafCost({ ...cloud, model: "unmeasured:cloud" }, deps), {}, "a meter row with no measured rate");
  deepEqual(leafCost({ ...cloud, model: "never-seen:cloud" }, deps), {}, "a model the meter never saw");
  deepEqual(leafCost({ ...claude, tokens: undefined }, deps), {}, "a leaf with no tokens");
});

// ── runCost: each unit summed on its own ────────────────────────────────────────

test("runCost: dollars and meter share are summed separately and never added together", () => {
  const c = runCost([claude, codex, cloud, { ...cloud, numTurns: 8 }], deps);
  near(c.usd, 0.77);
  near(c.weekPct, 4.0);
  equal(c.usdKind, "api-equivalent");
});

test("runCost: usd is billed only when every priced leaf was billed", () => {
  equal(runCost([{ ...claude, costUsd: 0.42 }, { ...codex, costUsd: 0.1 }], deps).usdKind, "billed");
  equal(runCost([{ ...claude, costUsd: 0.42 }, codex], deps).usdKind, "api-equivalent", "one estimate makes the sum an estimate");
});

test("runCost: a run with nothing priced is empty, not zero", () => {
  deepEqual(runCost([{ provider: "claude", model: "claude-sonnet-9", tokens: claude.tokens }], deps), {});
  deepEqual(runCost([], deps), {});
});

// ── costDeps: everything is read from the home it is handed ─────────────────────

function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "swarm-costdeps-"));
  try { return fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

test("costDeps: the rate cards come from the given home's store, not the process's SWARM_HOME", () => withTempHome((home) => {
  const model = "claude-only-in-this-home-9";
  const store = { claude: { url: "https://example.test", asOf: "2026-09-01T00:00:00.000Z", prices: { [model]: { input: 7, output: 9 } } } };
  writeFileSync(join(home, "rate-cards.json"), JSON.stringify(store));
  const leaf = { provider: "claude", model, tokens: tokens(1_000_000, 0, 0, 0) };
  deepEqual(leafCost(leaf, costDeps(home, ":cloud")), { usd: 7, usdKind: "api-equivalent" });
}));

test("costDeps: a cloud leaf under a non-default cloudSuffix still gets its meter share", () => withTempHome((home) => {
  writeFileSync(join(home, "usage-history.jsonl"), JSON.stringify(snap("2026-09-01T00:00:00.000Z", [seg("glm-5.3", 100, 20)], 50)) + "\n");
  const leaf = { provider: "ollama", model: "glm-5.3:x", numTurns: 10, tokens: cloud.tokens };
  const priced = leafCost(leaf, costDeps(home, ":x"));
  ok(priced.weekPct > 0, JSON.stringify(priced));
  deepEqual(leafCost({ ...leaf, model: "glm-5.3:cloud" }, costDeps(home, ":cloud")), { weekPct: priced.weekPct }, "the default suffix prices the same meter row");
}));

// ── formatCost: money is opt-in ─────────────────────────────────────────────────

test("formatCost: by default only the meter share prints, and no dollar sign", () => {
  const mixed = runCost([claude, codex, cloud], deps);
  equal(formatCost(mixed, { money: false }), "3.2% of week");
  ok(!formatCost(mixed, { money: false }).includes("$"));
});

test("formatCost: a run with only dollars prints nothing by default", () => {
  equal(formatCost(runCost([claude, codex], deps), { money: false }), "");
});

test("formatCost: with money the estimate leads, labelled api-eq, beside the meter share", () => {
  equal(formatCost(runCost([claude, codex, cloud], deps), { money: true }), "≈$0.77 api-eq · 3.2% of week");
});

test("formatCost: a billed total reads as a plain dollar figure", () => {
  equal(formatCost(runCost([{ ...claude, costUsd: 0.42 }], deps), { money: true }), "$0.42");
});

test("formatCost: nothing priced is the empty string in both modes", () => {
  for (const money of [true, false]) equal(formatCost({}, { money }), "");
});

test("formatCost: money must be exactly true — a truthy string does not switch dollars on", () => {
  equal(formatCost(runCost([claude], deps), { money: "false" }), "");
});

// ── display.money ───────────────────────────────────────────────────────────────

function cfgWith(display) {
  const dir = mkdtempSync(join(tmpdir(), "swarm-money-cfg-"));
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify(display === undefined ? {} : { display }));
    return loadConfig(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("display.money is off by default: nothing in the shipped config turns dollars on", () => {
  equal(cfgWith(undefined).display?.money === true, false);
});

test("display.money: true is honoured", () => {
  equal(cfgWith({ money: true }).display.money, true);
});

test("display.money must be a boolean: a string throws naming the key and the fix", () => {
  throws(() => cfgWith({ money: "yes" }), (e) => e.message.includes("display.money") && e.message.includes('"display": {"money": true}'));
});

// ── the price cards carry a cache-write column ──────────────────────────────────

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

test("openai parser reads the short-context cache-write column; a dash is no price, not zero", () => {
  const openai = parseOpenAiPricing(fixture("openai-pricing.md"));
  deepEqual(openai["gpt-6-luna"], { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 });
  equal(openai["gpt-5.5"].cacheWrite, undefined);
});

test("anthropic parser reads the 5-minute cache-write column, not the 1-hour one", () => {
  const anthropic = parseAnthropicPricing(fixture("anthropic-pricing.md"));
  deepEqual(anthropic["claude-opus-5-5"], { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 });
  equal(anthropic["claude-fable-5"].cacheWrite, 12.5);
});

test("diffPrices reports a cache-write-only reprice", () => {
  const before = { m: { input: 1, cachedInput: 0.1, output: 5, cacheWrite: 1.25 } };
  const after = { m: { input: 1, cachedInput: 0.1, output: 5, cacheWrite: 2 } };
  deepEqual(diffPrices(before, after).map((c) => [c.model, c.kind]), [["m", "repriced"]]);
  deepEqual(diffPrices(before, before), []);
});

test("formatCost output never carries a dollar sign unless money is on", () => {
  const all = runCost([claude, codex, cloud, { ...claude, costUsd: 0.5 }], deps);
  match(formatCost(all, { money: true }), /\$/);
  ok(!/\$/.test(formatCost(all, {})), "an unset option is off");
  ok(!/\$/.test(formatCost(all)), "so is a missing options bag");
});
