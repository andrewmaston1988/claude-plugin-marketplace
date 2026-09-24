import { test } from "node:test";
import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertPlausible, defaultRateCardStaleAfter, diffPrices, isRateCardStale,
  overlayRateCard, readRateCardStore, refreshRateCards,
  CODEX_RATE_CARD_SEED, CLAUDE_RATE_CARD_SEED, RATE_CARD_SOURCES,
} from "../src/rate-card.mjs";

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const storePath = () => join(mkdtempSync(join(tmpdir(), "swarm-rc-")), "rate-cards.json");

// The two vendor pages, served from the saved fixtures. Every refresh test runs
// entirely offline: the network is the one thing a test must never need.
const servePages = () => async (url) => ({
  ok: true,
  text: async () => fixture(url.includes("openai") ? "openai-pricing.md" : "anthropic-pricing.md"),
});

test("refresh: both tables are fetched, parsed and banked", async () => {
  const path = storePath();
  const summaries = await refreshRateCards({ path, _fetch: servePages(), now: new Date("2026-10-01T12:00:00Z") });

  deepEqual(summaries.map((s) => s.provider), ["codex", "claude"]);
  ok(summaries.every((s) => s.rows > 10), "RED: a table banked almost nothing");

  const store = readRateCardStore(path);
  equal(store.codex.prices["gpt-6-luna"].input, 0.1);
  equal(store.claude.prices["claude-sonnet-4-6"].input, 3);
  equal(store.claude.asOf, "2026-10-01T12:00:00.000Z");
  // The card is the record of where it came from, not just what it said.
  equal(store.claude.url, RATE_CARD_SOURCES.find((s) => s.provider === "claude").url);
});

test("refresh: the banked card supersedes the seed, and restarts the stale window", async () => {
  const path = storePath();
  await refreshRateCards({ path, _fetch: servePages(), now: new Date("2026-10-01T12:00:00Z") });
  const card = overlayRateCard(CLAUDE_RATE_CARD_SEED, readRateCardStore(path).claude);

  equal(card.asOf, "2026-10-01");
  equal(card.staleAfter, defaultRateCardStaleAfter("2026-10-01"), "RED: a fresh read kept the old shelf life");
  equal(isRateCardStale(card, Date.parse("2026-11-01")), false);
  equal(isRateCardStale(card, Date.parse("2027-11-01")), true);
  // Identity fields are the seed's: the published page names no base model.
  equal(card.baseModel, CLAUDE_RATE_CARD_SEED.baseModel);
  equal(card.unit, CLAUDE_RATE_CARD_SEED.unit);
  // And the whole published table is now priced, not just the seeded subset.
  ok(Object.keys(card.prices).length > Object.keys(CLAUDE_RATE_CARD_SEED.prices).length);
});

test("overlay: a card the vendor has dropped goes unpriced rather than lingering", () => {
  const seed = { ...CODEX_RATE_CARD_SEED };
  const card = overlayRateCard(seed, { asOf: "2026-10-01T00:00:00Z", prices: { "gpt-6-luna": { input: 1, output: 2 } } });
  equal(card.prices["gpt-6-luna"].input, 1);
  equal(card.prices["gpt-6-astra"], undefined, "RED: a dropped model kept its last-known price");
});

test("overlay: an empty or absent bank falls back to the seed", () => {
  deepEqual(overlayRateCard(CODEX_RATE_CARD_SEED, undefined), CODEX_RATE_CARD_SEED);
  deepEqual(overlayRateCard(CODEX_RATE_CARD_SEED, { prices: {} }), CODEX_RATE_CARD_SEED);
});

test("a corrupt store never takes the cards down", () => {
  const path = storePath();
  writeFileSync(path, "{ this is not json", "utf8");
  deepEqual(readRateCardStore(path), {});
});

test("a parse that comes back broken is refused, not banked", async () => {
  // Every one of these would otherwise overwrite a working card and render the
  // whole provider `unpriced` — the failure mode with no symptom but bad ranking.
  throws(() => assertPlausible("codex", { a: { input: 1, output: 2 } }), /parsed to 1 rows/);
  throws(() => assertPlausible("codex", {}), /parsed to 0 rows/);
  const five = (p) => ({ a: p, b: p, c: p, d: p, e: p });
  throws(() => assertPlausible("codex", five({ input: 0, output: 2 })), /input rate of 0/);
  throws(() => assertPlausible("codex", five({ input: 10, output: 2 })), /columns are transposed/);

  const path = storePath();
  await refreshRateCards({ path, _fetch: servePages() });
  const good = readRateCardStore(path);

  // A page that still returns 200 but no longer holds the table swallows the
  // parse silently; the refresh must leave the last good bank exactly as it was.
  await rejects(
    refreshRateCards({ path, _fetch: async () => ({ ok: true, text: async () => "# Pricing\n\nSee our plans page.\n" }) }),
    /the page shape moved/,
  );
  deepEqual(readRateCardStore(path), good, "RED: a failed refresh clobbered the banked card");

  await rejects(refreshRateCards({ path, _fetch: async () => ({ ok: false, status: 503 }) }), /503/);
  deepEqual(readRateCardStore(path), good, "RED: a failed fetch clobbered the banked card");
});

test("diffPrices: says what moved, which is the point of running a refresh", () => {
  const before = { keep: { input: 1, output: 2 }, gone: { input: 3, output: 4 }, up: { input: 5, output: 6 } };
  const after = { keep: { input: 1, output: 2 }, up: { input: 9, output: 6 }, fresh: { input: 7, output: 8 } };
  const byModel = Object.fromEntries(diffPrices(before, after).map((c) => [c.model, c.kind]));
  deepEqual(byModel, { gone: "dropped", up: "repriced", fresh: "added" }, "RED: an unchanged row was reported, or a changed one was not");
});

test("diffPrices: a moved cache rate counts as a reprice", () => {
  // Cache reads are most of what a swarm run bills, and the ratio is not uniform
  // across a family — a card that only watched `input` would miss the change.
  const changes = diffPrices({ m: { input: 4, cachedInput: 0.4, output: 20 } }, { m: { input: 4, cachedInput: 0.2, output: 20 } });
  deepEqual(changes.map((c) => c.kind), ["repriced"]);
});

test("diffPrices: a dated id the table publishes undated is unchanged, not dropped", () => {
  // The seed carries `claude-haiku-4-5-20251001`; the published table carries
  // `Claude Haiku 4.5`. Reported as dropped-and-added, a refresh reads as churn.
  const changes = diffPrices({ "claude-haiku-4-5-20251001": { input: 1, output: 5 } }, { "claude-haiku-4-5": { input: 1, output: 5 } });
  deepEqual(changes.filter((c) => c.model === "claude-haiku-4-5-20251001"), [], "RED: a still-priced model was reported dropped");
});
