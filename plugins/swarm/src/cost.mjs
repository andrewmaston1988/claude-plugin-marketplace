// Cost history — append-only JSONL at ~/.swarm/usage-history.jsonl, one line per
// live usage fetch that carried measurable weekly segments. `swarm cost` splits
// the lines into weeks and derives each model's per-request meter weight
// (multiplier against the cheapest measured model), so a seat's cost can be
// read beside `swarm perf`'s quality without ever collapsing the two into one
// number.
//
// Storage and derivation share this file: the thin I/O wrappers stay wrappers,
// the maths below them is pure over parsed snapshots.

import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { swarmHome } from "./config.mjs";
import { inferStoredIdentity } from "./results.mjs";
import { costObservation as validateCostObservation } from "./contracts.mjs";
import { deriveCloudName } from "./discovery.mjs";
import { provenanceBanner } from "./usage.mjs";

export function usageHistoryPath(env = process.env) {
  return join(swarmHome(env), "usage-history.jsonl");
}

// One snapshot per line, one write per snapshot — the same line-atomic contract
// as model-scores.jsonl, so concurrent swarms cannot corrupt the history.
export function appendSnapshot(snapshot, path = usageHistoryPath()) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(snapshot) + "\n", "utf8");
}

export function readSnapshots(path) {
  if (!existsSync(path)) return [];
  const snaps = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      snaps.push(JSON.parse(line));
    } catch {
      // torn tail write from a concurrent append — skip, never abort a query
    }
  }
  return snaps;
}

// ---- derivation ──────────────────────────────────────────────────────────────
// Ported field-for-field from the operator-side cost-table arithmetic: any
// disagreement between the two on the same history is a port defect, not a
// rounding difference. Pure maths — everything below takes parsed snapshots,
// nothing reads the filesystem.

export const THIN_REQUESTS = 200;
export const DEFAULT_COST_BANDS = [2, 5];
export const METER_POINTS_UNIT = "meter-points";
export const BILLED_CLASSIFICATION = "billed";
export const API_EQUIVALENT_CLASSIFICATION = "api-equivalent estimate";
export const UNPRICED_CLASSIFICATION = "unpriced";
// How far below the best frontier quality a model may sit and still be the
// "best value" pick. Arbitrary like the bands, and config for the same reason.
// This is a THRESHOLD, not a ratio: scores.mjs refuses to collapse quality and
// cost into one number, and a margin does not — a candidate must be undominated
// AND near the top AND not thin, so a cheap fluke clears none of the bars the
// ratio objection names.
export const DEFAULT_VALUE_MARGIN = 0.5;

function isoAsOf(value) {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function providerOf(snapshot, model) {
  if (typeof snapshot?.provider === "string" && snapshot.provider.trim()) return snapshot.provider.trim().toLowerCase();
  if (typeof model?.provider === "string" && model.provider.trim()) return model.provider.trim().toLowerCase();
  return inferStoredIdentity(model?.model || model)?.provider || null;
}

function identityOf(snapshot, segment) {
  const model = typeof segment === "string" ? segment : segment?.model;
  const provider = providerOf(snapshot, segment);
  return { provider, model };
}

function identityKey(identity) {
  return JSON.stringify([identity.provider || null, identity.model]);
}

function metadataOf(snapshot, segment, identity) {
  const unit = segment?.unit || snapshot?.unit || METER_POINTS_UNIT;
  const classification = segment?.classification || snapshot?.classification || UNPRICED_CLASSIFICATION;
  const metadata = {
    ...(identity.provider ? { provider: identity.provider } : {}),
    model: identity.model,
    ...(segment?.runner || snapshot?.runner ? { runner: segment?.runner || snapshot.runner } : {}),
    unit,
    source: segment?.source || snapshot?.source || (identity.provider === "ollama" ? "ollama-settings" : "provider-usage"),
    classification,
    asOf: isoAsOf(segment?.asOf || snapshot?.asOf || snapshot?.fetchedAt),
    costDomain: segment?.costDomain || snapshot?.costDomain || `${identity.provider || "legacy"}:${unit}:${classification}`,
  };
  // New observations use the shared contract. Old model-only snapshots remain
  // readable, but their missing provider stays visible instead of being guessed.
  if (metadata.provider) return { ...metadata, ...validateCostObservation(metadata) };
  return metadata;
}

// Public seam for providers that can produce a cost fact independently of the
// Ollama weekly meter. A subscription reading may be explicitly unpriced; an
// API price is an api-equivalent estimate, never a billed amount.
export function normalizeCostObservation(value, defaults = {}) {
  const input = {
    provider: value?.provider ?? defaults.provider,
    model: value?.model ?? defaults.model,
    unit: value?.unit ?? defaults.unit,
    source: value?.source ?? defaults.source,
    classification: value?.classification ?? defaults.classification,
    asOf: value?.asOf ?? defaults.asOf ?? Date.now(),
    ...(value?.value !== undefined ? { value: value.value } : defaults.value !== undefined ? { value: defaults.value } : {}),
  };
  const normalized = validateCostObservation({ ...input, asOf: isoAsOf(input.asOf) });
  return { ...value, ...normalized };
}

export function codexUnpricedObservation(model, { source = "codex-app-server", asOf = Date.now() } = {}) {
  return normalizeCostObservation({
    provider: "codex",
    model,
    unit: "usd",
    source,
    classification: UNPRICED_CLASSIFICATION,
    asOf,
  });
}

function meterSegments(snapshot) {
  return Array.isArray(snapshot?.weeklyModels) ? snapshot.weeklyModels : [];
}

function segmentKey(snapshot, segment) {
  return identityKey(identityOf(snapshot, segment));
}

// Split snapshots into weeks. Within a week a model's cumulative `requests`
// only ever RISES, so a count falling between two consecutive snapshots proves
// a reset happened between them — exact, no threshold, unlike watching
// weeklyPctUsed fall (an arbitrary margin that misses a boundary whenever the
// new week climbs past the old one's last reading). A model present in one
// snapshot and absent from the next proves a reset as surely: the page's model
// list is cumulative within a week, so disappearance is not an option mid-week.
export function splitWeeks(snaps) {
  if (!snaps.length) return [];
  const reqsOf = (s) => new Map(meterSegments(s).map((m) => [segmentKey(s, m), m.requests]));
  const weeks = [];
  let cur = [snaps[0]];
  for (let i = 1; i < snaps.length; i++) {
    const before = reqsOf(snaps[i - 1]);
    const after = reqsOf(snaps[i]);
    let reset = false;
    for (const [model, n] of after) {
      if (before.has(model) && n < before.get(model)) { reset = true; break; }
    }
    if (!reset) {
      for (const model of before.keys()) {
        if (!after.has(model)) { reset = true; break; }
      }
    }
    if (reset) {
      weeks.push(cur);
      cur = [];
    }
    cur.push(snaps[i]);
  }
  weeks.push(cur);
  return weeks;
}

// One reading per model per week, from that week's LAST snapshot — within a
// week the snapshots are repeated views of one running total, so a flat mean
// double-counts and weights the result by how often someone happened to
// fetch. `weeklyPctUsed x share` is the absolute figure; weeklyPctUsed cancels
// in any ratio between two models. A 0.0% share is "below the page's 0.1%
// resolution", not "free" — the row is still listed (a silent drop reads as
// never-used) but its cost stays unmeasured.
export function costPerModel(snaps) {
  const readings = new Map();
  for (const wk of splitWeeks(snaps)) {
    const last = wk[wk.length - 1];
    const pct = last.weeklyPctUsed ?? 0;
    for (const m of meterSegments(last)) {
      if (!m.requests) continue;
      const measured = m.meterSharePct > 0;
      const ptsPerReq = measured ? (pct * m.meterSharePct) / 100 / m.requests : null;
      const identity = identityOf(last, m);
      const key = identityKey(identity);
      if (!readings.has(key)) readings.set(key, { identity, metadata: metadataOf(last, m, identity), rows: [] });
      readings.get(key).rows.push({ requests: m.requests, ptsPerReq });
    }
  }
  const rows = [];
  for (const { identity, metadata, rows: rs } of readings.values()) {
    const reqs = rs.reduce((a, r) => a + r.requests, 0);
    // Weight over the weeks that produced a figure: a week below the page's
    // resolution contributes its requests to the total but cannot contribute
    // a rate — unknown, not zero.
    const seen = rs.filter((r) => r.ptsPerReq != null);
    const seenReqs = seen.reduce((a, r) => a + r.requests, 0);
    rows.push({
      ...metadata,
      ptsPerReq: seenReqs ? seen.reduce((a, r) => a + r.ptsPerReq * r.requests, 0) / seenReqs : null,
      requests: reqs,
      // The requests that actually PRODUCED the rate. The confidence gate reads
      // this one — an unmeasurable week must not buy a model the credibility
      // of volume it never contributed.
      measuredRequests: seenReqs,
      weeks: rs.length,
      measuredWeeks: seen.length,
    });
  }
  return rows;
}

// Multipliers relative to the cheapest model with >= THIN_REQUESTS measured
// requests. The floor must be a MEASURED model. An empty eligible set (nothing
// measured thick yet) has no floor: Math.min over nothing is Infinity, and
// pts/Infinity would fabricate a 0x cost for every measured model. Likewise a
// zero ptsPerReq (an empty meter) is not a free model.
export function multipliers(rows) {
  const domainOf = (r) => r.costDomain || `${r.provider || "legacy"}:${r.unit || METER_POINTS_UNIT}:${r.classification || "legacy"}`;
  const meter = (r) => !r.unit || r.unit === METER_POINTS_UNIT || r.unit === "quota-weight" || r.unit === "meter-points/request";
  const byDomain = new Map();
  for (const row of rows) {
    const domain = domainOf(row);
    const group = byDomain.get(domain) || [];
    group.push(row);
    byDomain.set(domain, group);
  }
  const floors = new Map();
  for (const [domain, group] of byDomain) {
    const eligible = group.filter((r) => meter(r) && r.measuredRequests >= THIN_REQUESTS && r.ptsPerReq != null && r.ptsPerReq > 0);
    floors.set(domain, eligible.length ? Math.min(...eligible.map((r) => r.ptsPerReq)) : null);
  }
  const out = rows.map((r) => {
    const floor = floors.get(domainOf(r));
    return {
      ...r,
      costDomain: domainOf(r),
      mult: meter(r) && floor != null && r.ptsPerReq != null && r.ptsPerReq > 0 ? r.ptsPerReq / floor : null,
    };
  });
  // Unmeasured rows sort last; they are listed to be seen, not ranked.
  out.sort((a, b) => (b.mult ?? -1) - (a.mult ?? -1));
  return out;
}

// Provider-local rate-card weights. Unlike the Ollama meter above, these rows
// carry a scalar value supplied by a provider's own rate card (for example a
// Codex plan-credit index). The caller names the provider's base model; no
// cross-provider floor is ever inferred. A missing base, value, or compatible
// domain stays unweighted rather than becoming a fabricated free model.
export function relativeCostRows(rows, { baseModel, baseModels = {} } = {}) {
  const domainOf = (row) => row.costDomain || `${row.provider || "legacy"}:${row.unit || "relative"}:${row.source || "unknown"}:${row.classification || UNPRICED_CLASSIFICATION}`;
  const groups = new Map();
  for (const row of rows) {
    const domain = domainOf(row);
    const group = groups.get(domain) || [];
    group.push(row);
    groups.set(domain, group);
  }
  const out = rows.map((row) => {
    const domain = domainOf(row);
    const group = groups.get(domain) || [];
    const provider = row.provider || "legacy";
    const chosen = typeof baseModel === "string" ? baseModel : baseModels[provider] || baseModels[domain];
    const base = group.find((candidate) => candidate.model === chosen && Number.isFinite(candidate.value) && candidate.value > 0);
    const mult = base && Number.isFinite(row.value) && row.value >= 0 ? row.value / base.value : null;
    return {
      ...row,
      costDomain: domain,
      ...(base ? { baseModel: base.model } : {}),
      mult,
    };
  });
  out.sort((a, b) => (a.mult ?? Infinity) - (b.mult ?? Infinity) || String(a.model).localeCompare(String(b.model)));
  return out;
}

// usage-history.jsonl is the Ollama meter's history. Its legacy rows predate
// provider-qualified identities and therefore contain bare model names; at
// this known Ollama boundary, map those names to the roster's cloud form and
// make the inferred provider explicit. Provider-qualified non-Ollama rows are
// already in their canonical form and must pass through unchanged.
export function ollamaCloudCostRows(snaps) {
  const canonical = snaps.map((snapshot) => ({
    ...snapshot,
    weeklyModels: meterSegments(snapshot).map((segment) => {
      const provider = segment?.provider || snapshot?.provider;
      if (provider && provider !== "ollama") return segment;
      const unit = segment?.unit || snapshot?.unit || METER_POINTS_UNIT;
      const classification = segment?.classification || snapshot?.classification || UNPRICED_CLASSIFICATION;
      return {
        ...segment,
        provider: "ollama",
        model: deriveCloudName(segment.model),
        costDomain: `ollama:${unit}:${classification}`,
      };
    }),
  }));
  return multipliers(costPerModel(canonical));
}

// ---- provider rate cards ─────────────────────────────────────────────────────
// A static $/Mtok table per provider, normalised to a base the table NAMES.
// "Explicit base" is the whole point: writing the base down means a later edit
// cannot silently move the unit every other row is measured in, which a derived
// floor (the cheapest entry) does the moment a cheap model is added.
//
// `prices` stores the PUBLISHED COLUMNS in USD per 1M tokens, not a collapsed
// ratio. A single stored number assumes a fixed output/input relationship, which
// Codex does not have — astra and sol are 5x output/input, terra, luna and 5.5
// are 6x — so collapsing goes silently wrong the moment one column moves alone.
// Storing the columns means a published change is edited where it was read.
//
// Keys are the ids swarm DISPATCHES, which is why haiku carries its date suffix
// while Anthropic's own table does not: keying on the table's bare id would
// render the model actually seated as `unpriced`. A model in neither table is a
// row that says `unpriced` — a wrong price ranks models wrongly for ever and
// nothing downstream can tell it from a sourced one.
//
// A subscription seat pays a flat fee, so even a sourced per-token figure is an
// equivalence rather than a bill. Rows priced from these tables are labelled
// `api-equivalent estimate`, never `billed`.

// openai.com help centre, "ChatGPT Rate Card (Enterprise token-based pricing)",
// the *ChatGPT Work and Codex models* table — the one that governs Codex CLI
// usage, not the Chat table above it. Read 2026-09-21.
// Cards with no published expiry are re-read after this deliberately short window.
export const RATE_CARD_STALE_WINDOW_DAYS = 90;

function defaultRateCardStaleAfter(asOf) {
  const date = new Date(`${asOf}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + RATE_CARD_STALE_WINDOW_DAYS);
  return date.toISOString().slice(0, 10);
}

// Sol's $4.00 is promotional "at least through November 21, 2026".
export const CODEX_RATE_CARD = {
  provider: "codex",
  baseModel: "gpt-5.6-luna",
  unit: "published-price-relative",
  source: "codex-rate-card",
  asOf: "2026-09-21",
  staleAfter: "2026-11-21", // Published promo floor, not the default window.
  prices: {
    "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
    "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
    "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
    "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
    "gpt-6-astra": { input: 10, cachedInput: 1, output: 50 },
  },
};

// Anthropic's published $/Mtok table (the model reference bundled with the
// claude-code-guide skill), read 2026-09-21. A family shares its tier's price
// (operator, 2026-09-21: "claude doesn't vary prices for a model family as far
// as I know"), so sonnet-4-6 carries sonnet's figures and opus-4-8 opus's rather
// than numbers of their own. Cache-read is published for Fable alone, so the
// field is absent elsewhere instead of guessed — a guessed cache rate would
// mis-rank long-context work permanently.
export const CLAUDE_RATE_CARD = {
  provider: "claude",
  baseModel: "claude-sonnet-5",
  unit: "published-price-relative",
  source: "anthropic-rate-card",
  asOf: "2026-09-21",
  // No published expiry: this is the default 90-day shelf life from asOf.
  staleAfter: defaultRateCardStaleAfter("2026-09-21"),
  prices: {
    "claude-haiku-4-5-20251001": { input: 1, output: 5 },
    "claude-sonnet-5": { input: 2, output: 10 },
    "claude-sonnet-4-6": { input: 2, output: 10, via: "claude-sonnet-5" },
    "claude-opus-5": { input: 5, output: 25 },
    "claude-opus-4-8": { input: 5, output: 25, via: "claude-opus-5" },
    "claude-fable-5-1": { input: 10, cachedInput: 0.25, output: 50 },
  },
};

export const RATE_CARDS = { codex: CODEX_RATE_CARD, claude: CLAUDE_RATE_CARD };
// The meter's provider id. Ollama's list is the one measured rather than
// published, which is why the three stay separate even though the labels rhyme.
export const METER_PROVIDER = "ollama";
export const COST_PROVIDERS = [METER_PROVIDER, ...Object.keys(RATE_CARDS)];

function rateCardStaleAfter(card) {
  if (card.staleAfter) return card.staleAfter;
  return defaultRateCardStaleAfter(card.asOf);
}

function rateCardBanner(card) {
  const staleAfter = rateCardStaleAfter(card);
  const staleAt = Date.parse(`${staleAfter}T23:59:59.999Z`);
  const stale = Date.now() > staleAt;
  return provenanceBanner({
    provenance: stale ? "cached" : "live",
    ...(stale ? { reason: "stale-rate-card" } : {}),
    provider: card.provider,
    lastSeen: card.asOf,
    refresh: "    Refresh: re-read the published rate card",
  });
}

// One row per model the caller names, plus one per model the table prices. A
// model absent from the table is `unpriced` — a row the page can draw, because
// a blank panel reads as broken and an unpriced row reads as honest.
function rateCardObservation(card, model) {
  const listed = Object.hasOwn(card.prices, model);
  return normalizeCostObservation({
    provider: card.provider,
    model,
    unit: card.unit,
    source: card.source,
    classification: listed ? API_EQUIVALENT_CLASSIFICATION : UNPRICED_CLASSIFICATION,
    asOf: card.asOf,
    costDomain: `${card.provider}:${card.unit}`,
    // The input column is the basis: swarm work is input- and cache-read
    // dominated, and for every Codex model cached input is exactly 0.1x input,
    // so that column yields the identical ratio. Output does not — an
    // output-basis card puts astra at 41.67x rather than 50x.
    ...(listed ? { value: card.prices[model].input } : {}),
    ...(listed && card.prices[model].via ? { pricedVia: card.prices[model].via } : {}),
  });
}

export function rateCardRows(card, models = []) {
  const named = [...new Set([
    ...models.filter((model) => typeof model === "string" && model.trim()),
    ...Object.keys(card.prices),
  ])];
  return relativeCostRows(
    named.map((model) => rateCardObservation(card, model)),
    { baseModels: { [card.provider]: card.baseModel } },
  );
}

// The one entry point every surface uses. Ollama's list comes from its banked
// weekly meter; Codex's and Claude's come from their static tables. There is
// deliberately no branch through which one provider's derivation can feed
// another's list — the units are incommensurable, and a shared floor would rank
// a measured meter point against a published price.
export function costRowsFor(provider, { models = [], snaps = [] } = {}) {
  const card = RATE_CARDS[provider];
  if (card) return rateCardRows(card, models);
  if (provider === METER_PROVIDER) return ollamaCloudCostRows(snaps);
  return [];
}

// The unit each list is read in, named on the list itself — including what the
// weight is relative to, because that is part of the weight. Two rate cards are
// two units, not one: each names its own base.
export function costUnitLabel(provider = METER_PROVIDER) {
  const card = RATE_CARDS[provider];
  return card
    ? `published price, relative (${card.baseModel} = 1x)`
    : `measured meter points/request, relative to the cheapest model with >=${THIN_REQUESTS} requests`;
}

// One section per provider, each ranked cheapest→dearest within itself. This is
// a grouping, never a ranking: no row is ever re-weighted against another
// section's base. A provider with no source still gets a section, so the reader
// sees that the provider exists and is unpriced rather than absent.
export function costSections({ providers = COST_PROVIDERS, models = {}, snaps = [] } = {}) {
  return providers.map((provider) => {
    const card = RATE_CARDS[provider];
    return {
      provider,
      unit: costUnitLabel(provider),
      rows: costRowsFor(provider, { models: models[provider] || [], snaps }),
      banner: card ? rateCardBanner(card) : [],
    };
  });
}

// Cost band for surfacing: 1 cheap, 2 mid, 3 expensive. Unmeasured is null.
export function band(mult, bands = DEFAULT_COST_BANDS) {
  if (mult == null || !Number.isFinite(mult)) return null;
  if (mult < bands[0]) return 1;
  if (mult <= bands[1]) return 2;
  return 3;
}

// Dashboard coins: 1–5 across ONE provider's own measured range (cheapest 1,
// dearest 5), spaced on a log scale because multipliers span orders of magnitude.
// Providers never share an axis, so a mid-priced Claude model is not squashed by
// a 273× Ollama outlier. A provider with a single price reads 1. Unmeasured is null.
export const MAX_COINS = 5;
export function coins(mult, range) {
  if (!range || mult == null || !Number.isFinite(mult) || mult <= 0) return null;
  if (range.hi <= range.lo) return 1;
  const t = Math.log(mult / range.lo) / Math.log(range.hi / range.lo);
  return 1 + Math.round(Math.max(0, Math.min(1, t)) * (MAX_COINS - 1));
}

// The band boundaries are arbitrary numbers, so they are config
// (`providers.ollama.cloud.ollama.costBands`), not constants. Anything malformed falls
// back to the default rather than inventing an edge out of a string.
export function resolveValueMargin(value, fallback = DEFAULT_VALUE_MARGIN) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function resolveBands(value, fallback = DEFAULT_COST_BANDS) {
  return Array.isArray(value) && value.length === 2
    && value.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
    ? [...value]
    : fallback;
}
