import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
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
  // The figures are the short-context tier; every Standard row publishes a dearer
  // long-context repeat. Reading the long columns by mistake shows up here.
  deepEqual(openai["gpt-6-astra"], { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 });
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

test("openai: columns are resolved by header, so the live column order reads correctly", () => {
  // OpenAI moved output and cached input ahead of the writes; the same figures
  // read by position put $0.125 in output and $0.50 in cached input.
  const page = [
    "### Standard pricing data",
    "| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write |",
    "| --- | --- | --- | --- | --- | --- |",
    "| gpt-6-luna | $0.10 | $0.50 | $0.01 | $0.125 | $0.25 |",
  ].join("\n");
  deepEqual(parseOpenAiPricing(page)["gpt-6-luna"],
    { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 });
});

test("openai: the older column order still reads the same fields", () => {
  // The guard for the fix: header lookup must not break the order it replaced.
  const page = [
    "### Standard pricing data",
    "| Model | Short context input | Short context cached input | Short context cache writes | Short context output |",
    "| --- | --- | --- | --- | --- |",
    "| gpt-6-luna | $0.10 | $0.01 | $0.125 | $0.50 |",
  ].join("\n");
  deepEqual(parseOpenAiPricing(page)["gpt-6-luna"],
    { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 });
});

test("openai: two tables with different column orders each resolve their own columns", () => {
  // One header index taken from the first table would mis-read the second.
  const page = [
    "### Standard pricing data",
    "| Model | Short context input | Short context output | Short context cached input | Short context 30m write |",
    "| --- | --- | --- | --- | --- |",
    "| gpt-6-luna | $0.10 | $0.50 | $0.01 | $0.125 |",
    "### Grouped Pricing Table data",
    "| Model | Short context input | Short context cached input | Short context output | Short context 30m write |",
    "| --- | --- | --- | --- | --- |",
    "| gpt-6-sol | $2.00 | $0.20 | $10.00 | $2.50 |",
  ].join("\n");
  const prices = parseOpenAiPricing(page);
  deepEqual(prices["gpt-6-luna"], { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 });
  deepEqual(prices["gpt-6-sol"], { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 });
});

test("openai: a header without the output column throws naming it, never guesses", () => {
  const page = [
    "### Standard pricing data",
    "| Model | Short context input | Short context cached input |",
    "| --- | --- | --- |",
    "| gpt-6-luna | $0.10 | $0.01 |",
  ].join("\n");
  throws(() => parseOpenAiPricing(page), /missing column 'output' in openai price table/);
});

test("a page with no matching table throws instead of parsing to nothing", () => {
  const page = "# Pricing\n\nSee our plans page.\n";
  throws(() => parseOpenAiPricing(page), /no openai price table found/);
  throws(() => parseAnthropicPricing(page), /no anthropic price table found/);
});

test("anthropic: display names become api ids, footnotes and links are stripped", () => {
  // `$0.20 / MTok<sup>2</sup>` — the marker must not end up in the number.
  deepEqual(anthropic["claude-opus-5-5"], { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 });
  // `Claude Mythos 5.1 ([limited availability](...))` — a linked qualifier in the name cell.
  deepEqual(anthropic["claude-mythos-5-1"], { input: 10, cachedInput: 0.25, cacheWrite: 12.5, output: 50 });
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

test("anthropic: columns are resolved by header, so a shuffled table reads correctly", () => {
  // Positional indexes would put output in input and the 1h write in cacheWrite.
  const page = [
    "| Model | Output tokens | Cache hits and refreshes | Base input tokens | 5m cache writes | 1h cache writes |",
    "| --- | --- | --- | --- | --- | --- |",
    "| Claude Sonnet 5 | $10.00 | $0.20 | $2.00 | $2.50 | $4.00 |",
  ].join("\n");
  deepEqual(parseAnthropicPricing(page)["claude-sonnet-5"],
    { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 });
});

test("openai: the Standard section's legacy four-column table is read too", () => {
  // The section republishes older models without a short/long split and without a
  // write column. Skipping it left every one of them unpriced for ever.
  deepEqual(openai["gpt-5"], { input: 1.25, cachedInput: 0.125, output: 10 });
  deepEqual(openai["gpt-4o"], { input: 2.5, cachedInput: 1.25, output: 10 });
});

test("openai: a Modality or Category table is never read as a standard per-token rate", () => {
  // `gpt-image-2` publishes an Image row and a Text row at different prices; a
  // prefix match on the legacy header would take whichever came first.
  const page = [
    "### Grouped Pricing Table data",
    "| Model | Modality | Input | Output | Cached input |",
    "| --- | --- | --- | --- | --- |",
    "| gpt-image-2 | Image | $8.00 | $30.00 | $2.00 |",
  ].join("\n");
  throws(() => parseOpenAiPricing(page), /no openai price table found/);
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
