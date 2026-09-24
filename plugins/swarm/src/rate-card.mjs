// Rate cards — what a published $/Mtok table says, and how it gets here.
//
// A subscription seat pays a flat fee, so even a sourced per-token figure is an
// equivalence rather than a bill. Rows priced from these tables are labelled
// `api-equivalent estimate`, never `billed`.
//
// The cards below are SEEDS: the last hand-read of each vendor's table, shipped so
// a fresh or offline install has something honest to rank with. `refreshRateCards`
// fetches the live tables, parses them (rate-card-parse.mjs) and banks the result
// at ~/.swarm/rate-cards.json, which overlays the seed from then on. Nobody should
// ever have to retype a price — the seed exists to be superseded, and the fixture
// test pins it against the page it was read off so it cannot drift unnoticed.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { swarmHome } from "./config.mjs";
import { provenanceBanner } from "./usage.mjs";
import { parseAnthropicPricing, parseOpenAiPricing, resolveRatePrice } from "./rate-card-parse.mjs";

// Cards with no published expiry are re-read after this deliberately short window.
export const RATE_CARD_STALE_WINDOW_DAYS = 90;

export function defaultRateCardStaleAfter(asOf) {
  const date = new Date(`${asOf}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + RATE_CARD_STALE_WINDOW_DAYS);
  return date.toISOString().slice(0, 10);
}

// Standard-tier columns only: the batch, flex and fast tables republish the same
// models at multiples of these and swarm dispatches none of them. Astra's figures
// are its sub-272k tier — it is the one row with breakpoint pricing ($20/$75 above).
export const CODEX_RATE_CARD_SEED = {
  provider: "codex",
  // Pinned deliberately: gpt-6-luna is now the cheapest row, but moving the base
  // would restate every codex multiplier ever banked against the old one.
  baseModel: "gpt-5.6-luna",
  unit: "published-price-relative",
  source: "codex-rate-card",
  asOf: "2026-09-23",
  staleAfter: "2026-11-21", // Sol's $4.00 promo floor, not the default window.
  prices: {
    "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 },
    "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
    "gpt-6-sol": { input: 2, cachedInput: 0.2, output: 10 },
    "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
    "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
    "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
    "gpt-6-astra": { input: 10, cachedInput: 1, output: 50 },
    "gpt-5.6-cyber": { input: 12.5, cachedInput: 1.25, output: 75 },
  },
};

// A family does NOT share one price: sonnet-4-6 bills $3/$15 against sonnet-5's
// $2/$10, and opus-5-5 undercuts opus-5 at $4/$20. Cache reads are 0.1x base input
// except opus-5-5 (0.05x) and fable-5-1 (0.025x); they are read off the table's own
// column rather than derived, because the ratio is not uniform.
export const CLAUDE_RATE_CARD_SEED = {
  provider: "claude",
  baseModel: "claude-sonnet-5",
  unit: "published-price-relative",
  source: "anthropic-rate-card",
  asOf: "2026-09-23",
  staleAfter: defaultRateCardStaleAfter("2026-09-23"), // No published expiry.
  prices: {
    "claude-haiku-4-5-20251001": { input: 1, cachedInput: 0.1, output: 5 },
    "claude-sonnet-5": { input: 2, cachedInput: 0.2, output: 10 },
    "claude-sonnet-4-6": { input: 3, cachedInput: 0.3, output: 15 },
    "claude-opus-5-5": { input: 4, cachedInput: 0.2, output: 20 },
    "claude-opus-5": { input: 5, cachedInput: 0.5, output: 25 },
    "claude-opus-4-8": { input: 5, cachedInput: 0.5, output: 25 },
    "claude-opus-4-7": { input: 5, cachedInput: 0.5, output: 25 },
    "claude-opus-4-6": { input: 5, cachedInput: 0.5, output: 25 },
    "claude-fable-5": { input: 10, cachedInput: 1, output: 50 },
    "claude-fable-5-1": { input: 10, cachedInput: 0.25, output: 50 },
  },
};

// Where each card comes from. `parse` owns the table's shape; the seed owns the
// fields the page does not publish — which model the unit is relative to, and what
// the card is called.
export const RATE_CARD_SOURCES = [
  { provider: "codex", url: "https://developers.openai.com/api/docs/pricing.md", parse: parseOpenAiPricing, seed: CODEX_RATE_CARD_SEED },
  { provider: "claude", url: "https://platform.claude.com/docs/en/about-claude/pricing.md", parse: parseAnthropicPricing, seed: CLAUDE_RATE_CARD_SEED },
];

export function rateCardStorePath(env = process.env) {
  return join(swarmHome(env), "rate-cards.json");
}

export function readRateCardStore(path = rateCardStorePath()) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // A torn or hand-mangled store must never take the cards down: fall through
    // to the seeds, which are always a valid card.
    return {};
  }
}

function writeRateCardStore(store, path = rateCardStorePath()) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  renameSync(tmp, path);
}

/**
 * A refresh replaces the seed's prices wholesale rather than merging: a model the
 * vendor has dropped must go `unpriced`, not linger at its last-known rate. The
 * banked `asOf` is when the fetch happened, and the stale window restarts there.
 */
export function overlayRateCard(seed, banked) {
  if (!banked?.prices || !Object.keys(banked.prices).length) return seed;
  const asOf = String(banked.asOf ?? "").slice(0, 10) || seed.asOf;
  return { ...seed, asOf, staleAfter: defaultRateCardStaleAfter(asOf), prices: banked.prices, refreshedFrom: banked.url };
}

/**
 * A parse that comes back empty, tiny, or full of nonsense means the page moved —
 * and banking it would replace every price with `unpriced` across the board. Refuse
 * the write and keep the card that works; the caller reports it and the operator
 * fixes the parser.
 */
export function assertPlausible(provider, prices) {
  const ids = Object.keys(prices);
  if (ids.length < 5) throw new Error(`${provider}: the published table parsed to ${ids.length} rows — the page shape moved, refusing to bank it`);
  for (const [id, p] of Object.entries(prices)) {
    if (!Number.isFinite(p.input) || p.input <= 0) throw new Error(`${provider}: ${id} parsed an input rate of ${p.input}`);
    if (!Number.isFinite(p.output) || p.output < p.input) throw new Error(`${provider}: ${id} parsed output ${p.output} below input ${p.input} — the columns are transposed`);
  }
}

/** Re-read both vendors' tables and bank them. Returns one summary per provider. */
export async function refreshRateCards({ path = rateCardStorePath(), _fetch = fetch, now = new Date() } = {}) {
  const store = readRateCardStore(path);
  const summaries = [];
  for (const { provider, url, parse, seed } of RATE_CARD_SOURCES) {
    const res = await _fetch(url);
    if (!res.ok) throw new Error(`${provider}: ${url} -> ${res.status}`);
    const prices = parse(await res.text());
    assertPlausible(provider, prices);
    const before = overlayRateCard(seed, store[provider]).prices;
    store[provider] = { url, asOf: now.toISOString(), prices };
    summaries.push({ provider, url, rows: Object.keys(prices).length, changes: diffPrices(before, prices) });
  }
  writeRateCardStore(store, path);
  return summaries;
}

/**
 * What moved between two price tables — the whole point of running a refresh.
 * Both sides resolve by the same prefix rule the pricing does, so a dated id the
 * published table lists undated reads as unchanged rather than as dropped-and-added.
 */
export function diffPrices(before, after) {
  const changes = [];
  const at = (table, id) => table[id] ?? resolveRatePrice(table, id)?.price;
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = at(before, id);
    const now = at(after, id);
    if (!was) changes.push({ model: id, kind: "added", to: now });
    else if (!now) changes.push({ model: id, kind: "dropped", from: was });
    else if (was.input !== now.input || was.output !== now.output || was.cachedInput !== now.cachedInput)
      changes.push({ model: id, kind: "repriced", from: was, to: now });
  }
  return changes;
}

export function rateCardStaleAfter(card) {
  return card.staleAfter || defaultRateCardStaleAfter(card.asOf);
}

export function isRateCardStale(card, now = Date.now()) {
  return now > Date.parse(`${rateCardStaleAfter(card)}T23:59:59.999Z`);
}

export function rateCardBanner(card) {
  const stale = isRateCardStale(card);
  return provenanceBanner({
    provenance: stale ? "cached" : "live",
    ...(stale ? { reason: "stale-rate-card" } : {}),
    provider: card.provider,
    lastSeen: card.asOf,
    refresh: "    Refresh: swarm refresh-prices",
  });
}

/** The card a model is priced by, seed overlaid with whatever has been banked. */
export function loadRateCards(path = rateCardStorePath()) {
  const store = readRateCardStore(path);
  return Object.fromEntries(RATE_CARD_SOURCES.map(({ provider, seed }) => [provider, overlayRateCard(seed, store[provider])]));
}

// Read once at import: every surface in a process should agree on the cards, and a
// refresh is a separate process (`swarm refresh-prices`) or an explicit reload.
export const RATE_CARDS = loadRateCards();
export const CODEX_RATE_CARD = RATE_CARDS.codex;
export const CLAUDE_RATE_CARD = RATE_CARDS.claude;

export { resolveRatePrice };
