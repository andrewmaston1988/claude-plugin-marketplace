import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseOpenAiPricing, parseAnthropicPricing, resolveRatePrice } from "../src/rate-card-parse.mjs";
import { CODEX_RATE_CARD_SEED, CLAUDE_RATE_CARD_SEED } from "../src/rate-card.mjs";

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

// Saved slices of the two vendors' published pages. They are deliberately frozen:
// what these pin is the PARSER, so a vendor changing a price must not move them.
const openai = parseOpenAiPricing(fixture("openai-pricing.md"));
const anthropic = parseAnthropicPricing(fixture("anthropic-pricing.md"));

test("openai: the short-context columns are read, and the qualifier is not part of the id", () => {
  // Astra is the one row with breakpoint pricing — $10/$50 below 272k, $20/$75 above.
  // Reading the long columns by mistake shows up here and nowhere else.
  deepEqual(openai["gpt-6-astra"], { input: 10, cachedInput: 1, output: 50 });
  // Published as `gpt-5.5 (<272K context length)`; the parenthetical is prose.
  deepEqual(openai["gpt-5.5"], { input: 5, cachedInput: 0.5, output: 30 });
  equal(openai["gpt-5.5 (<272K context length)"], undefined, "RED: the qualifier leaked into the id");
});

test("openai: a dash in the cache column means no cached rate, not zero", () => {
  // The pro tiers publish `-` for cached input. A zero here would rank them as free
  // to re-read, which is the opposite of true.
  equal(openai["gpt-5.5-pro"].cachedInput, undefined);
  equal(openai["gpt-5.5-pro"].input, 30);
});

test("anthropic: display names become api ids, footnotes and links are stripped", () => {
  // `$0.20 / MTok<sup>2</sup>` — the marker must not end up in the number.
  deepEqual(anthropic["claude-opus-5-5"], { input: 4, cachedInput: 0.2, output: 20 });
  // `Claude Mythos 5.1 ([limited availability](...))` — a linked qualifier in the name cell.
  deepEqual(anthropic["claude-mythos-5-1"], { input: 10, cachedInput: 0.25, output: 50 });
  // The cache column is read, never derived: this row is 0.025x input, not the usual 0.1x.
  equal(anthropic["claude-fable-5-1"].cachedInput, 0.25);
  equal(anthropic["claude-fable-5"].cachedInput, 1);
});

test("anthropic: a family does not share one price", () => {
  // The defect this whole parse replaces: sonnet-4-6 was carried at sonnet-5's rate,
  // ranking it a third cheaper than it bills.
  equal(anthropic["claude-sonnet-5"].input, 2);
  equal(anthropic["claude-sonnet-4-6"].input, 3);
  equal(anthropic["claude-opus-5-5"].input, 4);
  equal(anthropic["claude-opus-5"].input, 5);
});

test("both parses are whole — every row has a usable, plausible price", () => {
  for (const [label, parsed, min] of [["openai", openai, 25], ["anthropic", anthropic, 15]]) {
    ok(Object.keys(parsed).length >= min, `RED: ${label} parsed only ${Object.keys(parsed).length} rows — the table shape moved`);
    for (const [id, p] of Object.entries(parsed)) {
      ok(id.length > 2 && !/[|$()]/.test(id), `RED: ${label} produced a junk id: ${JSON.stringify(id)}`);
      for (const [field, v] of Object.entries(p))
        ok(Number.isFinite(v) && v > 0, `RED: ${label} ${id}.${field} is ${v}`);
      ok(p.output >= p.input, `RED: ${label} ${id} outputs cheaper than it inputs — columns are transposed`);
    }
  }
});

test("resolveRatePrice: a dated id prices as its undated row, and never as a longer sibling", () => {
  const prices = { "claude-opus-5": { input: 5 }, "claude-opus-5-5": { input: 4 }, "claude-haiku-4-5": { input: 1 } };
  equal(resolveRatePrice(prices, "claude-haiku-4-5-20251001").key, "claude-haiku-4-5");
  equal(resolveRatePrice(prices, "claude-opus-5").key, "claude-opus-5", "RED: an exact key lost to a prefix match");
  equal(resolveRatePrice(prices, "claude-opus-5-5").key, "claude-opus-5-5", "RED: opus-5 swallowed opus-5.5");
  equal(resolveRatePrice(prices, "claude-opus-5-5-20261101").key, "claude-opus-5-5", "RED: the longest prefix did not win");
  equal(resolveRatePrice(prices, "gpt-6-luna"), null);
});

// The bridge. The seeds are the only prices anyone types by hand — the fallback a
// fresh or offline install ranks with until `swarm refresh-prices` supersedes them —
// and this is what stops them drifting from the page they were read off. It bites
// both ways: a seed edited without the table, and a fixture refreshed without the
// seed. It deliberately reads the SEEDS, not the live cards, so a real refresh on
// this machine cannot turn it red.
test("the seeded rate cards match the published tables, row for row", () => {
  for (const [card, parsed] of [[CODEX_RATE_CARD_SEED, openai], [CLAUDE_RATE_CARD_SEED, anthropic]]) {
    for (const [model, priced] of Object.entries(card.prices)) {
      const found = resolveRatePrice(parsed, model);
      ok(found, `RED: ${card.provider} prices ${model}, the published table does not list it`);
      deepEqual(priced, found.price, `RED: ${model} disagrees with the published table`);
    }
  }
});
