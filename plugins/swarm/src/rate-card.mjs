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

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { swarmHome } from "./config.mjs";
import { provenanceBanner } from "./usage.mjs";
import { parseAnthropicPricing, parseOpenAiPricing, resolveRatePrice } from "./rate-card-parse.mjs";

const HOUR_MS = 3600e3;

// A card with no published expiry is re-read after this deliberately short window:
// one extra fetch of a markdown page a day, and a vendor's new price reaches Cost
// within half a day. Nothing computes a default `staleAfter` any more — an explicit
// one is a hand-noted override (a promo floor), never a substitute for the window.
export const RATE_CARD_REFRESH_HOURS = 12;

// A failed read is not retried until this much later: an offline machine would
// otherwise fetch on every `swarm cost` and every Cost page load, because a seed
// can never become fresh on its own.
export const RATE_CARD_FAILED_BACKOFF_HOURS = 1;

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
    "gpt-6-luna": { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
    "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
    "gpt-6-sol": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
    "gpt-5.6-terra": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
    "gpt-5.6-sol": { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 },
    "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
    "gpt-6-astra": { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
    "gpt-5.6-cyber": { input: 12.5, cachedInput: 1.25, cacheWrite: 15.625, output: 75 },
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
  asOf: "2026-09-23", // No published expiry: the 12h window is the whole rule.
  prices: {
    "claude-haiku-4-5-20251001": { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 },
    "claude-sonnet-5": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
    "claude-sonnet-4-6": { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
    "claude-opus-5-5": { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 },
    "claude-opus-5": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
    "claude-opus-4-8": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
    "claude-opus-4-7": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
    "claude-opus-4-6": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
    "claude-fable-5": { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
    "claude-fable-5-1": { input: 10, cachedInput: 0.25, cacheWrite: 12.5, output: 50 },
  },
};

// Where each card comes from. `parse` owns the table's shape; the seed owns the
// fields the page does not publish — which model the unit is relative to, and what
// the card is called.
export const RATE_CARD_SOURCES = [
  { provider: "codex", url: "https://developers.openai.com/api/docs/pricing.md", parse: parseOpenAiPricing, seed: CODEX_RATE_CARD_SEED },
  { provider: "claude", url: "https://platform.claude.com/docs/en/about-claude/pricing.md", parse: parseAnthropicPricing, seed: CLAUDE_RATE_CARD_SEED },
];

// The sources for the providers the config has switched on. A vendor whose provider
// is off is never a request: callers pass what this returns, never the catalogue.
export function rateCardSourcesFor(enabled) {
  return RATE_CARD_SOURCES.filter(({ provider }) => enabled.includes(provider));
}

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
  // Per-writer temp: the daemon and the CLI both bank here, and a shared name
  // makes the loser's rename throw ENOENT after the winner already took it.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  renameSync(tmp, path);
}

/**
 * A refresh replaces the seed's prices wholesale rather than merging: a model the
 * vendor has dropped must go `unpriced`, not linger at its last-known rate. The
 * banked `asOf` is when the fetch happened, at full resolution — the stale window
 * starts there, and 11 hours old and 23 hours old are the same day but only one of
 * them is inside it.
 */
export function overlayRateCard(seed, banked) {
  if (!banked?.prices || !Object.keys(banked.prices).length) return seed;
  // The seed's `staleAfter` is a hand note about the SEED's read — a promo floor.
  // Riding onto a later read would mark every read after it stale for ever, and an
  // always-stale card re-fetches on every cost query.
  const { staleAfter, ...rest } = seed;
  return {
    ...rest,
    asOf: banked.asOf ?? seed.asOf,
    prices: banked.prices,
    refreshedFrom: banked.url,
    ...(banked.rosterIds ? { rosterIds: banked.rosterIds } : {}),
    // `lastFailedAt` is the back-off marker, read from the raw store by whoever
    // decides whether to retry. On the card it read as "the banner knows" when
    // nothing but the raw read ever consulted it.
  };
}

/**
 * A parse that comes back empty, tiny, or full of nonsense means the page moved —
 * and banking it would replace every price with `unpriced` across the board. Refuse
 * the write and keep the card that works; the caller reports it and the operator
 * fixes the parser.
 */
export function assertPlausible(provider, prices, seed) {
  const ids = Object.keys(prices);
  if (ids.length < 5) throw new Error(`${provider}: the published table parsed to ${ids.length} rows — the page shape moved, refusing to bank it`);
  for (const [id, p] of Object.entries(prices)) {
    if (!Number.isFinite(p.input) || p.input <= 0) throw new Error(`${provider}: ${id} parsed an input rate of ${p.input}`);
    if (!Number.isFinite(p.output) || p.output < p.input) throw new Error(`${provider}: ${id} parsed output ${p.output} below input ${p.input} — the columns are transposed`);
  }
  // Without the base every multiplier in that section is null while the label
  // still names it — and an automatic refresh would bank that in silence.
  if (seed && !resolveRatePrice(prices, seed.baseModel))
    throw new Error(`${provider}: the published table does not price ${seed.baseModel}, which is the unit every other row is priced against — refusing to bank it`);
}

// A failure banks `lastFailedAt` and rethrows carrying the provider and the
// summaries of the providers already banked; the caller's error path reads both.
export async function refreshRateCards({ path = rateCardStorePath(), _fetch = fetch, now = new Date(), rosterIds, providers } = {}) {
  const store = readRateCardStore(path);
  const summaries = [];
  for (const { provider, url, parse, seed } of providers) {
    try {
      const res = await _fetch(url);
      if (!res.ok) throw new Error(`${provider}: ${url} -> ${res.status}`);
      const prices = parse(await res.text());
      assertPlausible(provider, prices, seed);
      const before = overlayRateCard(seed, store[provider]).prices;
      store[provider] = {
        url, asOf: now.toISOString(), prices,
        ...(rosterIds?.[provider] ? { rosterIds: rosterIds[provider] } : {}),
      };
      summaries.push({ provider, url, rows: Object.keys(prices).length, changes: diffPrices(before, prices) });
    } catch (e) {
      // Re-read before writing: another writer (the daemon against the CLI) may
      // have banked a fresh card in the read-to-write window, and writing this
      // run's opening snapshot back would revert it and bank an hour of back-off
      // over prices that were just re-read.
      const fresh = readRateCardStore(path);
      for (const { provider: banked } of summaries) fresh[banked] = store[banked];
      fresh[provider] = { ...fresh[provider], lastFailedAt: now.toISOString() };
      writeRateCardStore(fresh, path);
      e.provider = provider;
      // The providers before this one are banked by the write above; their
      // summaries ride the throw so the caller can report them as refreshed.
      e.summaries = summaries;
      throw e;
    }
  }
  // The same re-read as the failure path: a partial refresh (the other provider is
  // backed off) must not put its opening snapshot back over a fresher bank.
  const fresh = readRateCardStore(path);
  for (const { provider } of summaries) fresh[provider] = store[provider];
  writeRateCardStore(fresh, path);
  return summaries;
}

/**
 * What moved between two price tables — the whole point of running a refresh.
 * Both sides resolve by the rule the pricing does — an exact key, or a trailing
 * published date — so a dated id the table lists undated reads as unchanged
 * rather than as dropped-and-added.
 */
export function diffPrices(before, after) {
  const changes = [];
  const at = (table, id) => table[id] ?? resolveRatePrice(table, id)?.price;
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = at(before, id);
    const now = at(after, id);
    if (!was) changes.push({ model: id, kind: "added", to: now });
    else if (!now) changes.push({ model: id, kind: "dropped", from: was });
    else if (was.input !== now.input || was.output !== now.output || was.cachedInput !== now.cachedInput || was.cacheWrite !== now.cacheWrite)
      changes.push({ model: id, kind: "repriced", from: was, to: now });
  }
  return changes;
}

// Past the window, past an explicit `staleAfter`, or the roster names a model the
// card never priced (one-way — a leaver needs no prices). An unparsable `asOf` is stale.
export function isRateCardStale(card, { now = Date.now(), rosterIds = [] } = {}) {
  const at = typeof now === "number" ? now : new Date(now).getTime();
  const readAt = Date.parse(card?.asOf ?? "");
  if (!Number.isFinite(readAt)) return true;
  if (at - readAt >= RATE_CARD_REFRESH_HOURS * HOUR_MS) return true;
  if (card.staleAfter && at > Date.parse(`${card.staleAfter}T23:59:59.999Z`)) return true;
  const priced = new Set(card.rosterIds ?? []);
  return rosterIds.some((id) => !priced.has(id));
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

const cache = new Map();

/**
 * The cards in force, cached per store path and re-read when that file's mtime
 * moves. Reading once at import would freeze a running daemon on the prices it
 * started with — a refresh has to reach it without a restart.
 */
export function rateCards(path = rateCardStorePath()) {
  let mtimeMs = null;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // No store yet: the seeds stand, and a later write moves the mtime off null.
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.cards;
  const cards = loadRateCards(path);
  cache.set(path, { mtimeMs, cards });
  return cards;
}

const money = (p) => (p == null ? "—" : `$${p.input}/$${p.output}`);

export function reportCardChanges(out, { provider, url, rows, changes }) {
  out(`── ${provider} — ${rows} models from ${url}`);
  if (!changes.length) {
    out("   no change");
  } else {
    for (const c of changes) {
      out(c.kind === "repriced"
        ? `   ${c.model.padEnd(28)} ${money(c.from)} -> ${money(c.to)}`
        : `   ${c.model.padEnd(28)} ${c.kind}${c.to ? ` at ${money(c.to)}` : ""}`);
    }
  }
  out("");
}

/**
 * No flag gates this: a stale card ranks models on prices the vendor has already
 * changed, and that is never what anyone wants. Best-effort — offline, the cached
 * card stands and its own stale banner already says so.
 *
 * The back-off lives in the store, not in a caller's memory, and it is per
 * provider: one vendor's moved page must not hold a healthy vendor's prices stale
 * for the hour. `rosterIds` is per provider, banked with the read so a model
 * arriving later re-prices the card.
 *
 * A skip writes nothing: the daemon asks on every cost request, and a line per
 * poll is noise. `skipped` is the report.
 */
export async function refreshStaleRateCards({ out, err, path = rateCardStorePath(), _fetch = fetch, now = Date.now(), rosterIds, enabled } = {}) {
  const at = typeof now === "number" ? new Date(now) : now;
  const store = readRateCardStore(path);
  const pending = rateCardSourcesFor(enabled).filter(({ provider }) => {
    const failedAt = Date.parse(store[provider]?.lastFailedAt ?? "");
    return !(Number.isFinite(failedAt) && at.getTime() - failedAt < RATE_CARD_FAILED_BACKOFF_HOURS * 3600e3);
  });

  const cards = rateCards(path);
  const stale = pending.some(({ provider }) =>
    isRateCardStale(cards[provider], { now: at.getTime(), rosterIds: rosterIds?.[provider] }));
  if (!stale) return { refreshed: [], failed: [], skipped: true };

  try {
    const summaries = await refreshRateCards({ path, _fetch, now: at, rosterIds, providers: pending });
    for (const summary of summaries) if (summary.changes.length) reportCardChanges(out, summary);
    return { refreshed: summaries.map((s) => s.provider), failed: [], skipped: false };
  } catch (e) {
    // Whatever banked before the failure is banked — reported as refreshed, so the
    // message never calls a provider that just re-priced itself "cached".
    const banked = e.summaries ?? [];
    for (const summary of banked) if (summary.changes.length) reportCardChanges(out, summary);
    err(`rate cards: ${e.provider ?? "a provider"} could not be refreshed (${e.message}) — its card stays cached`);
    return { refreshed: banked.map((s) => s.provider), failed: [e.provider].filter(Boolean), skipped: false };
  }
}

export { resolveRatePrice };
