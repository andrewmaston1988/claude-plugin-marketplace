// Provider-local rate cards — the published price tables, the rows derived from
// them, and the staleness banners. Split from cost.test.mjs, which keeps the
// snapshot storage and the meter-derived multiplier arithmetic.
import { test } from "node:test";
import { equal, deepEqual, ok, match } from "node:assert/strict";
import {
  ollamaCloudCostRows, costRowsFor, costSections, costUnitLabel, rateCardRows,
  COST_PROVIDERS, RATE_CARDS, CODEX_RATE_CARD, CLAUDE_RATE_CARD,
} from "../src/cost.mjs";
import { snap, seg } from "./helpers/cost-snapshots.mjs";

// ── provider-local rate cards ─────────────────────────────────────────────────
// Three lists, one per provider, each ranked cheapest→dearest within its own
// accounting unit. Never one merged list: a measured Ollama meter point and a
// published Codex price do not share an axis, and a shared floor would rank one
// against the other silently and permanently.

// A history whose model name collides with a Codex id, and which prices that
// name at 9x its own floor. Any leak of the meter into the Codex list hands the
// Codex row a real, wrong number rather than a null.
const collidingSnaps = () => [
  snap(1, [seg("gpt-5.6-luna:cloud", 100, 50), seg("cheap:cloud", 900, 50)], 50),
];

// The plan's named RED anchor. Nothing guarded this before: the Ollama
// derivation and the provider tables had no seam between them.
test("costRowsFor: an Ollama meter multiplier never attaches to a Codex model", () => {
  const snaps = collidingSnaps();
  const leaked = ollamaCloudCostRows(snaps).find((r) => r.model.startsWith("gpt-5.6-luna"));
  ok(leaked, "the fixture must actually price the colliding name, or this test proves nothing");
  ok(leaked.mult !== 1, `the meter's own weight for the colliding name is ${leaked.mult} — the fixture must make it differ from the table's 1x`);

  const rows = costRowsFor("codex", { models: ["gpt-5.6-luna"], snaps });
  const luna = rows.find((r) => r.model === "gpt-5.6-luna");
  ok(luna, "the Codex base is missing from its own list");
  equal(luna.mult, 1, "RED: the Ollama meter's weight leaked onto a Codex model");
  equal(luna.baseModel, "gpt-5.6-luna");
  equal(luna.costDomain, `codex:${CODEX_RATE_CARD.unit}`, "a Codex row lives in the Codex cost domain");
  ok(rows.every((r) => r.unit !== "meter-points"), "RED: a meter unit reached the Codex list");
  ok(rows.every((r) => r.source !== "ollama-settings"), "RED: an Ollama source reached the Codex list");
  ok(rows.every((r) => r.provider === "codex"), "RED: another provider's row landed in the Codex list");
});

// The absolute form of the same invariant: the history cannot reach the table's
// list at all — not through a request count, not through a quota percentage.
// `swarm-provider-economics:63` forbids deriving USD from quota outright.
test("costRowsFor: a Codex weight is never derived from the usage history or a quota percentage", () => {
  const quiet = [snap(1, [seg("m:cloud", 400, 100)], 10)];
  const busy = [snap(1, [seg("m:cloud", 400, 100)], 90)];
  const asked = { models: ["gpt-5.6-luna", "gpt-5.6-sol"] };
  deepEqual(costRowsFor("codex", { ...asked, snaps: busy }), costRowsFor("codex", { ...asked, snaps: quiet }),
    "RED: the table's weights moved with the banked quota history");
  deepEqual(costRowsFor("codex", { ...asked, snaps: busy }), costRowsFor("codex", asked),
    "RED: the Codex list read the history it must never read");
  deepEqual(costRowsFor("claude", { ...asked, snaps: busy }), costRowsFor("claude", asked));
});

test("costRowsFor: each provider's list is normalised to its own named base", () => {
  equal(CODEX_RATE_CARD.baseModel, "gpt-5.6-luna");
  equal(CLAUDE_RATE_CARD.baseModel, "claude-sonnet-5");
  const codex = costRowsFor("codex", { models: ["gpt-5.6-luna", "gpt-5.6-sol"] });
  equal(codex.find((r) => r.model === "gpt-5.6-luna").mult, 1, "RED: the Codex base is not exactly 1x");
  const claude = costRowsFor("claude", { models: ["claude-sonnet-5", "claude-opus-5"] });
  equal(claude.find((r) => r.model === "claude-sonnet-5").mult, 1, "RED: the Claude base is not exactly 1x");
  ok(codex.every((r) => r.costDomain.startsWith("codex:")), "a Codex list carries only Codex domains");
  ok(claude.every((r) => r.costDomain.startsWith("claude:")), "a Claude list carries only Claude domains");
  ok(!codex.some((r) => r.model === "claude-sonnet-5"), "a Codex list never carries a Claude model");
});

// Cheapest→dearest is tested on a synthetic card so the ordering logic is pinned
// independently of whatever the shipped tables happen to contain. A named base
// of 2 with a cheaper entry of 1 is the whole point: the unit is the model the
// table names, never the cheapest row it happens to contain.
test("rateCardRows: ranks cheapest first within one provider, unmeasured last, base named not derived", () => {
  const card = { provider: "codex", baseModel: "b", unit: "u", source: "s", asOf: "2026-09-21",
    prices: { b: { input: 2, output: 10 }, dear: { input: 8, output: 40 }, cheap: { input: 1, output: 5 } } };
  // The roster is what gets a row — a refreshed card carries a whole back
  // catalogue, so naming models is how a caller says which ones it can dispatch.
  const rows = rateCardRows(card, ["unknown", "b", "dear", "cheap"]);
  deepEqual(rows.map((r) => r.model), ["cheap", "b", "dear", "unknown"], "RED: cheapest first, unmeasured last");
  equal(rows[0].mult, 0.5);
  equal(rows.find((r) => r.model === "b").mult, 1, "RED: the floor was derived from the cheapest row, not the named base");
  equal(rows.find((r) => r.model === "dear").mult, 4);
  equal(rows.find((r) => r.model === "unknown").mult, null);
});

// A model absent from its table is a ROW, not a blank. The Claude section of
// the dashboard was empty for exactly this reason and read as broken.
test("costRowsFor: a model absent from its table is an unpriced row, never a blank", () => {
  // Rosalind is in the rate card's *Chat* table and absent from the Work/Codex
  // one this card is read from, so it is genuinely unpriced for a Codex seat.
  const rows = costRowsFor("codex", { models: ["gpt-rosalind-research"] });
  const absent = rows.find((r) => r.model === "gpt-rosalind-research");
  ok(absent, "RED: the model was dropped from the list — a blank panel reads as broken");
  equal(absent.mult, null, "RED: a weight was invented for a model with no published price");
  equal(absent.classification, "unpriced");
  equal(absent.provider, "codex");
  ok(costRowsFor("codex").some((r) => r.model === CODEX_RATE_CARD.baseModel), "the table's own models are always listed");
  ok(costRowsFor("claude", { models: ["claude-opus-5"] }).some((r) => r.model === "claude-opus-5"));
});

// A card stores the PUBLISHED COLUMNS, not a collapsed ratio. Collapsing assumes
// a fixed output/input relationship, which Codex does not have — astra and sol
// are 5x output/input, terra, luna and 5.5 are 6x — so a single stored number
// silently goes wrong the moment one column moves on its own.
test("rate cards: each price is the published columns, so a column change updates the card", () => {
  // developers.openai.com/api/docs/pricing, standard tier. Astra's is its
  // sub-272k tier — the one row on the page with breakpoint pricing.
  deepEqual(CODEX_RATE_CARD.prices["gpt-6-astra"], { input: 10, cachedInput: 1, output: 50 });
  deepEqual(CODEX_RATE_CARD.prices["gpt-6-sol"], { input: 2, cachedInput: 0.2, output: 10 });
  deepEqual(CODEX_RATE_CARD.prices["gpt-6-luna"], { input: 0.1, cachedInput: 0.01, output: 0.5 });
  deepEqual(CODEX_RATE_CARD.prices["gpt-5.6-cyber"], { input: 12.5, cachedInput: 1.25, output: 75 });
  deepEqual(CODEX_RATE_CARD.prices["gpt-5.6-sol"], { input: 4, cachedInput: 0.4, output: 20 });
  deepEqual(CODEX_RATE_CARD.prices["gpt-5.6-terra"], { input: 2, cachedInput: 0.2, output: 12 });
  deepEqual(CODEX_RATE_CARD.prices["gpt-5.6-luna"], { input: 0.2, cachedInput: 0.02, output: 1.2 });
  deepEqual(CODEX_RATE_CARD.prices["gpt-5.5"], { input: 5, cachedInput: 0.5, output: 30 });

  // platform.claude.com/docs/en/about-claude/pricing. Cache reads are 0.1x base
  // input, except opus-5-5 (0.05x) and fable-5-1 (0.025x) — both footnoted there.
  deepEqual(CLAUDE_RATE_CARD.prices["claude-haiku-4-5-20251001"], { input: 1, cachedInput: 0.1, output: 5 });
  deepEqual(CLAUDE_RATE_CARD.prices["claude-sonnet-5"], { input: 2, cachedInput: 0.2, output: 10 });
  deepEqual(CLAUDE_RATE_CARD.prices["claude-sonnet-4-6"], { input: 3, cachedInput: 0.3, output: 15 });
  deepEqual(CLAUDE_RATE_CARD.prices["claude-opus-5-5"], { input: 4, cachedInput: 0.2, output: 20 });
  deepEqual(CLAUDE_RATE_CARD.prices["claude-opus-5"], { input: 5, cachedInput: 0.5, output: 25 });
  deepEqual(CLAUDE_RATE_CARD.prices["claude-fable-5"], { input: 10, cachedInput: 1, output: 50 });
  deepEqual(CLAUDE_RATE_CARD.prices["claude-fable-5-1"], { input: 10, cachedInput: 0.25, output: 50 });
});

// The basis is the INPUT column. Swarm leaves are input- and cache-read
// dominated (a measured implementation leaf: 2.12M in, 12.8k out), and for
// every Codex model cached input is exactly 0.1x input, so the cached column
// yields the identical ratio. The output column does NOT: an output-basis card
// puts astra at 41.67x and sol at 16.67x, which is what the two values below pin.
test("costRowsFor: a rate-card multiplier is the input column over the card's named base", () => {
  const rows = costRowsFor("codex");
  const mult = (id) => rows.find((r) => r.model === id)?.mult;
  equal(mult("gpt-5.6-luna"), 1, "RED: the base must be exactly 1x");
  equal(mult("gpt-6-luna"), 0.5, "RED: gpt-6-luna is $0.10 input — half the base, and the cheapest row on the card");
  equal(mult("gpt-6-sol"), 10, "RED: gpt-6-sol is $2.00 input against luna's $0.20");
  equal(mult("gpt-5.6-terra"), 10, "RED: terra is $2.00 input against luna's $0.20");
  equal(mult("gpt-5.6-sol"), 20, "RED: sol is $4.00 input against luna's $0.20 — 16.67x means an output basis");
  equal(mult("gpt-5.5"), 25, "RED: 5.5 is $5.00 input against luna's $0.20");
  equal(mult("gpt-6-astra"), 50, "RED: astra is $10.00 input against luna's $0.20 — 41.67x means an output basis");
  equal(mult("gpt-5.6-cyber"), 62.5, "RED: cyber is $12.50 input against luna's $0.20");
  // The base is pinned, not derived. gpt-6-luna is cheaper than it, and the day
  // the base follows the cheapest row every banked codex multiplier restates.
  equal(CODEX_RATE_CARD.baseModel, "gpt-5.6-luna",
    "RED: the unit moved to the new cheapest model — every prior multiplier now means something else");
});

test("CLAUDE_RATE_CARD: the published ratios, keyed on the ids swarm dispatches", () => {
  const rows = costRowsFor("claude");
  const mult = (id) => rows.find((r) => r.model === id)?.mult;
  equal(mult("claude-haiku-4-5-20251001"), 0.5, "RED: haiku is $1 input against sonnet's $2");
  equal(mult("claude-sonnet-5"), 1, "RED: the base must be exactly 1x");
  equal(mult("claude-opus-5"), 2.5, "RED: opus is $5 input against sonnet's $2");
  equal(mult("claude-fable-5-1"), 5, "RED: fable is $10 input against sonnet's $2");
  equal(mult("claude-fable-5"), 5, "RED: fable-5 is $10 input, same base rate as 5.1 — only its cache read differs");
  // A Claude family does NOT share one price. Every row here is its own line in
  // the published table, and two of them contradict the family reading outright:
  // sonnet-4-6 bills $3 against sonnet-5's $2, and opus-5-5 UNDERCUTS opus-5.
  equal(mult("claude-sonnet-4-6"), 1.5, "RED: sonnet-4-6 is $3 input, not the sonnet-5 tier's $2");
  equal(mult("claude-opus-5-5"), 2, "RED: opus-5-5 is $4 input — cheaper than opus-5, not equal to it");
  equal(mult("claude-opus-4-8"), 2.5, "RED: opus-4-8 is $5 input");
  equal(mult("claude-opus-4-7"), 2.5, "RED: opus-4-7 is $5 input");
  equal(mult("claude-opus-4-6"), 2.5, "RED: opus-4-6 is $5 input");
  // The catalog's haiku id carries a date suffix the rate doc's does not. Keying
  // on the doc's bare id renders the model swarm actually seats as `unpriced`.
  ok(!Object.keys(CLAUDE_RATE_CARD.prices).includes("claude-haiku-4-5"),
    "RED: the card is keyed on the doc's bare haiku id, not the one swarm dispatches");
});

// A price READ off the table and a price inferred from a sibling are not the
// same evidence, and the row has to say which — an inference that renders
// identically to a reading is how a made-up 1.5x for sonnet-4-6 shipped in #307,
// and how the "families share a tier" correction to it then buried the real $3.
// No shipped row is inferred any more, so the marker is exercised on a card of
// its own: a mechanism with no live instance is pinned or it rots.
test("rate cards: an inferred price is marked as one, a directly published price is not", () => {
  for (const card of Object.values(RATE_CARDS))
    for (const [id, price] of Object.entries(card.prices))
      equal(price.via, undefined, `RED: ${id} is inferred from a sibling — every shipped row must be its own published line`);

  const provider = "test-inferred-price";
  RATE_CARDS[provider] = {
    provider, baseModel: "base", unit: "published-price-relative", source: "test-rate-card",
    asOf: "2020-01-01", staleAfter: "2099-01-01",
    prices: { base: { input: 2, output: 10 }, sibling: { input: 2, output: 10, via: "base" } },
  };
  try {
    const row = (id) => costRowsFor(provider).find((r) => r.model === id);
    equal(row("sibling").pricedVia, "base", "RED: the marker never reached the row");
    equal(row("base").pricedVia, undefined, "RED: a published row was marked as inferred");
    // The inference marks provenance; it must not change the number.
    equal(row("sibling").mult, row("base").mult);
  } finally {
    delete RATE_CARDS[provider];
  }
});

// The pinned key sets ARE the sourcing record: adding a row without reading it
// off a published table fails here, which is the only thing standing between a
// guessed price and a permanent mis-rank.
test("rate cards: no price is invented — every key traces to a published table", () => {
  deepEqual(Object.keys(CODEX_RATE_CARD.prices).sort(), [
    "gpt-5.5", "gpt-5.6-cyber", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
    "gpt-6-astra", "gpt-6-luna", "gpt-6-sol",
  ], "RED: a Codex price was added or removed without updating the published set");
  deepEqual(Object.keys(CLAUDE_RATE_CARD.prices).sort(), [
    "claude-fable-5", "claude-fable-5-1", "claude-haiku-4-5-20251001",
    "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8",
    "claude-opus-5", "claude-opus-5-5", "claude-sonnet-4-6", "claude-sonnet-5",
  ], "RED: a Claude price was added or removed without updating the published set");
  // A model in neither table is a row that says so, never a blank and never a guess.
  const rosalind = costRowsFor("codex", { models: ["gpt-rosalind-research"] })
    .find((r) => r.model === "gpt-rosalind-research");
  equal(rosalind.mult, null, "a model absent from the table must carry no weight");
});

test("rate cards: a published-price weight is an api-equivalent estimate, never a bill", () => {
  const base = costRowsFor("codex", { models: ["gpt-5.6-luna"] }).find((r) => r.model === "gpt-5.6-luna");
  equal(base.classification, "api-equivalent estimate",
    "RED: a subscription-derived figure was labelled as money actually spent");
  ok(costRowsFor("claude", { models: ["claude-sonnet-5", "claude-opus-5"] }).every((r) => r.classification !== "billed"));
});

test("costUnitLabel: each list is labelled in its own unit, naming its own base", () => {
  match(costUnitLabel("ollama"), /meter points/);
  ok(costUnitLabel("codex").includes(CODEX_RATE_CARD.baseModel), "the Codex label must name what it is relative to");
  ok(costUnitLabel("claude").includes(CLAUDE_RATE_CARD.baseModel));
  ok(costUnitLabel("codex") !== costUnitLabel("claude"), "two bases are two units, not one label");
});

test("COST_PROVIDERS: one entry per provider with a cost source, Ollama's meter first", () => {
  deepEqual(COST_PROVIDERS, ["ollama", "codex", "claude"]);
});

test("costSections: one section per provider, never a merged list", () => {
  const sections = costSections({ snaps: collidingSnaps(), models: { codex: ["gpt-5.6-sol"] } });
  deepEqual(sections.map((s) => s.provider), ["ollama", "codex", "claude"], "a provider with no source still gets a section");
  ok(sections.every((s) => s.rows.every((r) => (r.provider || "ollama") === s.provider)),
    "RED: one provider's rows landed in another's section");
  ok(sections.every((s) => typeof s.unit === "string" && s.unit.length), "every section states its own unit");
  const ollama = sections.find((s) => s.provider === "ollama");
  deepEqual(ollama.rows.map((r) => r.model), ollamaCloudCostRows(collidingSnaps()).map((r) => r.model),
    "the Ollama section is still the meter's own rows");
  // A section per provider is not a ranking across providers: no row is ever
  // re-weighted against another section's base.
  ok(sections.every((s) => s.rows.every((r) => !r.baseModel || s.provider !== "ollama")),
    "a rate-card base priced an Ollama meter row");
});

test("costSections: a past-dated rate card announces its stale published prices", () => {
  const provider = "test-stale-rate-card";
  RATE_CARDS[provider] = {
    provider, baseModel: "base", unit: "published-price-relative", source: "test-rate-card",
    asOf: "2020-01-01", staleAfter: "2020-02-01", prices: { base: { input: 1, output: 1 } },
  };
  try {
    const section = costSections({ providers: [provider] })[0];
    ok(section.banner.length > 0, "RED: a past-dated rate card must announce itself");
    match(section.banner.join("\n"), /Stale Rate Card/);
    match(section.banner.join("\n"), new RegExp(provider));
    match(section.banner.join("\n"), /2020-01-01T00:00:00\.000Z/);
    equal(section.banner[1], "    Refresh: swarm refresh-prices");
  } finally {
    delete RATE_CARDS[provider];
  }
});

test("costSections: a fresh rate card stays silent", () => {
  const provider = "test-fresh-rate-card";
  RATE_CARDS[provider] = {
    provider, baseModel: "base", unit: "published-price-relative", source: "test-rate-card",
    asOf: "2020-01-01", staleAfter: "2099-01-01", prices: { base: { input: 1, output: 1 } },
  };
  try {
    const section = costSections({ providers: [provider] })[0];
    deepEqual(section.banner, [], "RED: a fresh rate card must not print a stale-data banner");
  } finally {
    delete RATE_CARDS[provider];
  }
});

test("costSections: a stale rate-card row keeps its published value", () => {
  const provider = "test-stale-value";
  RATE_CARDS[provider] = {
    provider, baseModel: "base", unit: "published-price-relative", source: "test-rate-card",
    asOf: "2020-01-01", staleAfter: "2020-02-01", prices: { base: { input: 7, output: 1 } },
  };
  try {
    const row = costSections({ providers: [provider] })[0].rows.find((candidate) => candidate.model === "base");
    equal(row.value, 7, "RED: a stale rate card must retain its published price");
  } finally {
    delete RATE_CARDS[provider];
  }
});

test("costSections: a default shelf life does not override an explicit expiry", () => {
  const explicitProvider = "test-explicit-expiry";
  const defaultProvider = "test-default-expiry";
  RATE_CARDS[explicitProvider] = {
    provider: explicitProvider, baseModel: "base", unit: "published-price-relative", source: "test-rate-card",
    asOf: "2020-01-01", staleAfter: "2099-01-01", prices: { base: { input: 1, output: 1 } },
  };
  RATE_CARDS[defaultProvider] = {
    provider: defaultProvider, baseModel: "base", unit: "published-price-relative", source: "test-rate-card",
    asOf: "2020-01-01", prices: { base: { input: 1, output: 1 } },
  };
  try {
    const [explicit, defaulted] = costSections({ providers: [explicitProvider, defaultProvider] });
    deepEqual(explicit.banner, [], "RED: an explicit staleAfter must win over the default shelf life");
    ok(defaulted.banner.length > 0, "RED: a card with no expiry must use the default shelf life");
  } finally {
    delete RATE_CARDS[explicitProvider];
    delete RATE_CARDS[defaultProvider];
  }
});

test("rate cards: shipped staleAfter dates are still in the future", () => {
  for (const card of [CODEX_RATE_CARD, CLAUDE_RATE_CARD]) {
    ok(card.staleAfter, `RED: ${card.provider} must state when its rate card goes stale`);
    ok(Date.parse(`${card.staleAfter}T23:59:59.999Z`) > Date.now(),
      `RED: ${card.provider}'s rate card is past ${card.staleAfter}; re-read the published price table`);
  }
});
