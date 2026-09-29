import { test } from "node:test";
import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertPlausible, diffPrices, isRateCardStale, overlayRateCard, readRateCardStore,
  refreshRateCards, resolveRatePrice,
  CODEX_RATE_CARD_SEED, CLAUDE_RATE_CARD_SEED, RATE_CARD_SOURCES,
} from "../src/rate-card.mjs";
import { refreshPrices, refreshStaleRateCards } from "../src/rate-card-cli.mjs";

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const storePath = () => join(mkdtempSync(join(tmpdir(), "swarm-rc-")), "rate-cards.json");

// The two vendor pages, served from the saved fixtures. Every refresh test runs
// entirely offline: the network is the one thing a test must never need.
const servePages = () => async (url) => ({
  ok: true,
  text: async () => fixture(url.includes("openai") ? "openai-pricing.md" : "anthropic-pricing.md"),
});

// The openai page as usual, claude's behind it down — codex is read first.
const halfDown = () => {
  const pages = servePages();
  return async (url) => (url.includes("openai") ? pages(url) : { ok: false, status: 503 });
};

// The published page with the card's base model's row cut out — the shape a
// vendor-side table reshuffle leaves behind.
const baseLess = (url) => url.includes("openai")
  ? fixture("openai-pricing.md")
  : fixture("anthropic-pricing.md").split("\n").filter((line) => !/^\|\s*Claude Sonnet 5\s*\|/.test(line)).join("\n");

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

test("refresh: the banked card supersedes the seed and keeps the full read timestamp", async () => {
  const path = storePath();
  await refreshRateCards({ path, _fetch: servePages(), now: new Date("2026-10-01T12:00:00Z") });
  const card = overlayRateCard(CLAUDE_RATE_CARD_SEED, readRateCardStore(path).claude);

  // Full resolution, not a sliced date: 11 hours old and 23 hours old are the
  // same day and only one of them is inside the window.
  equal(card.asOf, "2026-10-01T12:00:00.000Z");
  equal(isRateCardStale(card, { now: Date.parse("2026-10-01T22:00:00Z") }), false, "RED: 10h old must still be fresh");
  equal(isRateCardStale(card, { now: Date.parse("2026-10-02T01:00:00Z") }), true, "RED: 13h old must be stale");
  // Identity fields are the seed's: the published page names no base model.
  equal(card.baseModel, CLAUDE_RATE_CARD_SEED.baseModel);
  equal(card.unit, CLAUDE_RATE_CARD_SEED.unit);
  // And the whole published table is now priced, not just the seeded subset.
  ok(Object.keys(card.prices).length > Object.keys(CLAUDE_RATE_CARD_SEED.prices).length);
});

test("overlay: a fresh read does not inherit the seed's hand-noted expiry", () => {
  // The Codex seed's `staleAfter` marks the end of a promo window on the SEED's
  // hand-read. Riding onto a later read would mark every read after it stale for
  // ever, and an always-stale card re-fetches on every cost query.
  const card = overlayRateCard(CODEX_RATE_CARD_SEED, { asOf: "2026-10-01T12:00:00Z", prices: { "gpt-6-luna": { input: 1, output: 2 } } });
  equal(card.staleAfter, undefined, "RED: the seed's promo floor rode onto a freshly read card");
  equal(CODEX_RATE_CARD_SEED.staleAfter, "2026-11-21", "the seed itself still carries it");
});

test("overlay: the back-off marker stays in the store, never on the card", () => {
  // Nothing reads it off a card: the banner judges `asOf`, `staleAfter` and the
  // roster, and the retry decision reads the raw store.
  const card = overlayRateCard(CLAUDE_RATE_CARD_SEED, {
    asOf: "2026-10-01T12:00:00Z", prices: { "claude-sonnet-5": { input: 2, output: 10 } },
    lastFailedAt: "2026-10-01T13:00:00Z",
  });
  equal(card.lastFailedAt, undefined, "RED: a store marker rode onto a card nothing reads it from");
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

test("staleness: 11h is fresh, 13h is stale, and an asOf that will not parse is stale", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  const at = (asOf) => ({ asOf });
  equal(isRateCardStale(at("2026-10-02T01:00:00.000Z"), { now }), false, "RED: an 11h-old card must still be fresh");
  equal(isRateCardStale(at("2026-10-01T23:00:00.000Z"), { now }), true, "RED: a 13h-old card must be stale");
  equal(isRateCardStale(at("not a date"), { now }), true, "RED: a card whose read time cannot be read is not fresh");
  // A seed's date-only asOf parses as midnight UTC, so a fresh install is stale
  // on first use and re-reads rather than ranking on a hand-read for 12 hours.
  equal(isRateCardStale(at("2026-10-02"), { now }), true);
});

test("staleness: the 12h boundary itself — an instant under it is fresh, the mark is stale", () => {
  const asOf = Date.parse("2026-10-02T00:00:00Z");
  const card = { asOf: new Date(asOf).toISOString() };
  // Stepped in a literal 12h, not RATE_CARD_REFRESH_HOURS: against the constant
  // the boundary would move with it and the pin would never bite.
  equal(isRateCardStale(card, { now: asOf + 12 * 3600e3 - 1 }), false, "RED: an instant inside the window was called stale");
  equal(isRateCardStale(card, { now: asOf + 12 * 3600e3 }), true, "RED: the 12h mark itself must be stale");
});

test("staleness: an explicit expiry expires a card inside the window, and only then", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  const asOf = "2026-10-02T11:00:00.000Z";
  equal(isRateCardStale({ asOf, staleAfter: "2026-10-01" }, { now }), true,
    "RED: a passed expiry must expire a card that is only an hour old");
  equal(isRateCardStale({ asOf, staleAfter: "2026-11-01" }, { now }), false,
    "RED: an expiry still in the future must not add staleness");
});

test("staleness: a roster id the card has not seen re-prices it, an id leaving does not", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  const card = { asOf: "2026-10-02T11:00:00.000Z", rosterIds: ["a", "b"] };
  equal(isRateCardStale(card, { now, rosterIds: ["a", "b"] }), false);
  equal(isRateCardStale(card, { now, rosterIds: ["a", "c"] }), true,
    "RED: a model the card has never priced must re-price it");
  equal(isRateCardStale(card, { now, rosterIds: ["a"] }), false,
    "RED: a model leaving the roster needs no new prices");
  equal(isRateCardStale({ asOf: "2026-10-02T11:00:00.000Z" }, { now, rosterIds: ["a"] }), true,
    "RED: a card banked before rosters were recorded has seen nothing");
});

test("refresh: the roster the card was priced for is banked with it", async () => {
  const path = storePath();
  const now = new Date("2026-10-01T12:00:00Z");
  const rosterIds = { claude: ["claude-sonnet-5", "claude-opus-5-5"] };
  await refreshRateCards({ path, _fetch: servePages(), now, rosterIds });

  const card = overlayRateCard(CLAUDE_RATE_CARD_SEED, readRateCardStore(path).claude);
  deepEqual(card.rosterIds, rosterIds.claude);
  const later = now.getTime() + 3600e3;
  equal(isRateCardStale(card, { now: later, rosterIds: rosterIds.claude }), false);
  equal(isRateCardStale(card, { now: later, rosterIds: [...rosterIds.claude, "claude-sonnet-5-5"] }), true,
    "RED: a model that arrives in the roster between refreshes must re-price the card");
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
  const now = new Date("2026-10-02T12:00:00Z");
  await refreshRateCards({ path, _fetch: servePages(), now: new Date("2026-10-01T12:00:00Z") });
  const good = readRateCardStore(path);

  // A page that still returns 200 but no longer holds the table swallows the
  // parse silently; the refresh must leave the last good bank exactly as it was.
  await rejects(
    refreshRateCards({ path, _fetch: async () => ({ ok: true, text: async () => "# Pricing\n\nSee our plans page.\n" }), now }),
    /the page shape moved/,
  );
  const afterShape = readRateCardStore(path);
  deepEqual(afterShape.claude.prices, good.claude.prices, "RED: a failed refresh clobbered the banked prices");
  equal(afterShape.claude.asOf, good.claude.asOf);
  equal(afterShape.codex.lastFailedAt, now.toISOString(), "RED: a failed attempt must be banked, or the next read re-fetches blindly");

  await rejects(refreshRateCards({ path, _fetch: async () => ({ ok: false, status: 503 }), now }), /503/);
  const afterFetch = readRateCardStore(path);
  deepEqual(afterFetch.claude.prices, good.claude.prices, "RED: a failed fetch clobbered the banked prices");
  equal(afterFetch.codex.lastFailedAt, now.toISOString());
});

test("a parse that has lost the seed's base model is refused, not banked", async () => {
  const five = (p) => ({ a: p, b: p, c: p, d: p, e: p });
  const seed = { provider: "claude", baseModel: "claude-sonnet-5" };
  // Without the base every multiplier in the section is null while the label
  // still names it, and an automatic 12h refresh would bank that in silence.
  throws(() => assertPlausible("claude", five({ input: 1, output: 2 }), seed), /does not price claude-sonnet-5/);
  assertPlausible("claude", { ...five({ input: 1, output: 2 }), "claude-sonnet-5": { input: 2, output: 10 } }, seed);

  const path = storePath();
  await refreshRateCards({ path, _fetch: servePages(), now: new Date("2026-10-01T12:00:00Z") });
  const good = readRateCardStore(path);
  await rejects(refreshRateCards({ path, _fetch: async (url) => ({ ok: true, text: async () => baseLess(url) }) }), /does not price claude-sonnet-5/);
  deepEqual(readRateCardStore(path).claude.prices, good.claude.prices, "RED: a base-less parse was banked");
});

test("refresh: a failure never writes back a snapshot taken before another writer banked", async () => {
  const path = storePath();
  const pages = servePages();
  await refreshRateCards({ path, _fetch: pages, now: new Date("2026-10-01T12:00:00Z") });
  const now = new Date("2026-10-02T12:00:00Z");

  // The other writer — the daemon against the CLI — banks a fresh claude card
  // inside this run's read-to-write window: the store is read at the top of the
  // refresh, and written again on claude's failure, minutes of fetching later.
  const other = {
    url: "https://example.test/pricing.md",
    asOf: "2026-10-02T11:59:00.000Z",
    prices: { "claude-sonnet-5": { input: 9, output: 9 } },
  };
  await rejects(refreshRateCards({
    path, now,
    _fetch: async (url) => {
      if (url.includes("openai")) return pages(url);
      writeFileSync(path, JSON.stringify({ ...readRateCardStore(path), claude: other }), "utf8");
      return { ok: false, status: 503 };
    },
  }), /503/);

  const store = readRateCardStore(path);
  equal(store.claude.asOf, other.asOf, "RED: the failure path reverted a card another writer had just banked");
  deepEqual(store.claude.prices, other.prices, "RED: the failure path put stale prices back over a fresher read");
  equal(store.claude.lastFailedAt, now.toISOString(), "RED: the failure must still be banked");
  equal(store.codex.asOf, now.toISOString(), "RED: this run's own banked provider went down with the write");
});

test("refresh: a partial refresh never writes back a card another writer banked meanwhile", async () => {
  const path = storePath();
  const pages = servePages();
  await refreshRateCards({ path, _fetch: pages, now: new Date("2026-10-01T12:00:00Z") });
  const now = new Date("2026-10-02T12:00:00Z");

  // A run that reads codex alone — what the per-provider back-off produces — and
  // the other writer banked claude inside its window.
  const other = {
    url: "https://example.test/pricing.md",
    asOf: "2026-10-02T11:59:00.000Z",
    prices: { "claude-sonnet-5": { input: 9, output: 9 } },
  };
  await refreshRateCards({
    path, now, providers: [RATE_CARD_SOURCES[0]],
    _fetch: async (url) => {
      writeFileSync(path, JSON.stringify({ ...readRateCardStore(path), claude: other }), "utf8");
      return pages(url);
    },
  });

  const store = readRateCardStore(path);
  equal(store.claude.asOf, other.asOf, "RED: a codex-only refresh wrote its opening snapshot back over a fresh claude card");
  deepEqual(store.claude.prices, other.prices);
  equal(store.codex.asOf, now.toISOString(), "RED: the provider that was read did not land");
});

test("refresh: a foreign writer's temp at the shared name never blocks the bank", async () => {
  const path = storePath();
  // The name a fixed `${path}.tmp` collides on: two writers racing for it leave
  // the loser renaming a file the winner has already taken.
  mkdirSync(`${path}.tmp`);
  const summaries = await refreshRateCards({ path, _fetch: servePages(), now: new Date("2026-10-01T12:00:00Z") });

  deepEqual(summaries.map((s) => s.provider), ["codex", "claude"]);
  equal(readRateCardStore(path).claude.asOf, "2026-10-01T12:00:00.000Z");
});

test("refreshStaleRateCards: one vendor's back-off does not hold the other's prices stale", async () => {
  const path = storePath();
  const now = Date.parse("2026-10-02T12:00:00Z");
  await refreshRateCards({ path, _fetch: servePages(), now: new Date("2026-10-01T12:00:00Z") });
  // codex's page moved and failed a minute ago; claude's is reachable and its card
  // is a day old. Holding claude back costs a full day of a price it can re-read.
  const store = readRateCardStore(path);
  store.codex = { ...store.codex, lastFailedAt: new Date(now - 60e3).toISOString() };
  writeFileSync(path, JSON.stringify(store), "utf8");

  const asked = [];
  const pages = servePages();
  const result = await refreshStaleRateCards({
    out: () => {}, err: () => {}, path, now,
    _fetch: async (url) => { asked.push(url.includes("openai") ? "codex" : "claude"); return pages(url); },
  });

  deepEqual(result.refreshed, ["claude"], "RED: a healthy provider was held back by another vendor's back-off");
  deepEqual(asked, ["claude"], "RED: the provider that backed off was asked again");
  equal(readRateCardStore(path).claude.asOf, new Date(now).toISOString(), "RED: the reachable vendor's prices were left stale");
  equal(readRateCardStore(path).codex.lastFailedAt, new Date(now - 60e3).toISOString(),
    "RED: the back-off marker was cleared without a successful read");
});

test("refreshStaleRateCards: a failed attempt backs that provider off for an hour", async () => {
  const path = storePath();
  await refreshRateCards({ path, _fetch: servePages(), now: new Date("2026-10-01T12:00:00Z") });

  const failedAt = Date.parse("2026-10-02T12:00:00Z");
  let calls = 0;
  const offline = async () => { calls += 1; throw new Error("getaddrinfo ENOTFOUND"); };
  const errs = [];
  const io = { out: () => {}, err: (line) => errs.push(line) };

  const first = await refreshStaleRateCards({ ...io, path, _fetch: offline, now: failedAt });
  deepEqual(first.failed, ["codex"], "RED: a failed provider must be named");
  equal(first.skipped, false);
  equal(readRateCardStore(path).codex.lastFailedAt, new Date(failedAt).toISOString(), "RED: a failed attempt must be banked");
  ok(errs.some((line) => /could not be refreshed/.test(line)), "RED: a failed refresh must say so");

  // 59 minutes later codex is not retried — but claude, which has never failed,
  // still is. One vendor's dead page must not hold the other's prices stale.
  const second = await refreshStaleRateCards({ ...io, path, _fetch: offline, now: failedAt + 59 * 60e3 });
  deepEqual(second.failed, ["claude"]);
  equal(calls, 2);

  // Both have now failed, so a call inside the hour fetches nothing at all.
  const third = await refreshStaleRateCards({ ...io, path, _fetch: offline, now: failedAt + 59.5 * 60e3 });
  deepEqual(third, { refreshed: [], failed: [], skipped: true },
    "RED: an offline machine must not re-fetch on every cost query");
  equal(calls, 2);

  // Past codex's hour the back-off lifts — the card is still stale and unpriced.
  const fourth = await refreshStaleRateCards({ ...io, path, _fetch: offline, now: failedAt + 61 * 60e3 });
  equal(calls, 3);
  deepEqual(fourth.failed, ["codex"]);

  // A card that is not stale is never fetched at all.
  await refreshRateCards({ path, _fetch: servePages(), now: new Date("2026-10-02T18:00:00Z") });
  const quiet = await refreshStaleRateCards({ ...io, path, _fetch: offline, now: Date.parse("2026-10-02T19:00:00Z") });
  deepEqual(quiet, { refreshed: [], failed: [], skipped: true });
  equal(calls, 3);
});

test("refreshStaleRateCards: a refresh banks the card and reports what moved", async () => {
  const path = storePath();
  await refreshRateCards({ path, _fetch: servePages(), now: new Date("2026-10-02T18:00:00Z") });
  const result = await refreshStaleRateCards({
    out: () => {}, err: () => {}, path, _fetch: servePages(),
    now: Date.parse("2026-10-03T09:00:00Z"),
    rosterIds: { claude: ["claude-sonnet-4-6"] },
  });

  deepEqual(result, { refreshed: ["codex", "claude"], failed: [], skipped: false });
  const card = readRateCardStore(path).claude;
  equal(card.asOf, "2026-10-03T09:00:00.000Z", "RED: a stale card was reported refreshed without re-reading it");
  deepEqual(card.rosterIds, ["claude-sonnet-4-6"], "RED: the roster the card was priced for was not banked");
});

test("refresh: a throw carries what the providers before it banked", async () => {
  const path = storePath();
  let caught;
  try {
    await refreshRateCards({ path, _fetch: halfDown(), now: new Date("2026-10-03T09:00:00Z") });
  } catch (e) {
    caught = e;
  }
  equal(caught.provider, "claude");
  deepEqual(caught.summaries.map((s) => s.provider), ["codex"],
    "RED: the banked provider's summary went down with the throw");
  equal(readRateCardStore(path).codex.asOf, "2026-10-03T09:00:00.000Z",
    "RED: the summary describes a read that was never banked");
});

test("refreshStaleRateCards: a banked provider is reported refreshed when the other fails", async () => {
  const path = storePath();
  const now = Date.parse("2026-10-03T09:00:00Z");
  const errs = [];
  const result = await refreshStaleRateCards({
    out: () => {}, err: (line) => errs.push(line), path, _fetch: halfDown(), now,
  });

  deepEqual(result, { refreshed: ["codex"], failed: ["claude"], skipped: false },
    "RED: a provider that banked new prices was reported as not refreshed");
  equal(readRateCardStore(path).claude.lastFailedAt, new Date(now).toISOString());
  equal(errs.length, 1);
  equal(errs[0].includes("claude"), true, "RED: the failure must name the provider that failed");
  equal(errs[0].includes("codex"), false, "RED: the message calls the banked provider's card cached");
});

test("refreshPrices banks the roster, so a manual refresh never wipes what the automatic one banked", async () => {
  const path = storePath();
  const rosterIds = { claude: ["claude-sonnet-5", "claude-opus-5-5"] };
  await refreshRateCards({ path, _fetch: servePages(), now: new Date("2026-10-03T09:00:00Z"), rosterIds });

  const code = await refreshPrices({ out: () => {}, err: () => {}, path, _fetch: servePages(), rosterIds });
  equal(code, 0);

  const card = overlayRateCard(CLAUDE_RATE_CARD_SEED, readRateCardStore(path).claude);
  deepEqual(card.rosterIds, rosterIds.claude, "RED: the manual refresh wiped the banked roster");
  equal(isRateCardStale(card, { rosterIds: rosterIds.claude }), false,
    "RED: with no roster banked, every cost query re-fetches both vendor pages");
});

test("diffPrices: says what moved, which is the point of running a refresh", () => {
  const before = { keep: { input: 1, output: 2 }, gone: { input: 3, output: 4 }, up: { input: 5, output: 6 } };
  const after = { keep: { input: 1, output: 2 }, up: { input: 9, output: 6 }, fresh: { input: 7, output: 8 } };
  const byModel = Object.fromEntries(diffPrices(before, after).map((c) => [c.model, c.kind]));
  deepEqual(byModel, { gone: "dropped", up: "repriced", fresh: "added" }, "RED: an unchanged row was reported, or a changed one was not");
});

test("diffPrices: a published sibling reads as added, not as no change", () => {
  // The elder's key must not claim the new id, or a table that gained a model
  // reports an empty diff and the refresh looks like a no-op.
  const before = { "claude-sonnet-5": { input: 2, output: 10 } };
  const after = { "claude-sonnet-5": { input: 2, output: 10 }, "claude-sonnet-5-5": { input: 2, output: 10 } };
  deepEqual(diffPrices(before, after), [{ model: "claude-sonnet-5-5", kind: "added", to: { input: 2, output: 10 } }],
    "RED: a newly published model was swallowed by its elder's prefix");
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

test("resolveRatePrice: only a trailing DATE is stripped, never a version segment", () => {
  const dated = { "claude-haiku-4-5": { input: 1, output: 5 }, "gpt-5": { input: 1, output: 2 } };
  equal(resolveRatePrice(dated, "claude-haiku-4-5").key, "claude-haiku-4-5");
  equal(resolveRatePrice(dated, "claude-haiku-4-5-20251001").key, "claude-haiku-4-5");
  equal(resolveRatePrice(dated, "gpt-5-2025-08-07").key, "gpt-5", "RED: the dashed date form must resolve too");
  // A version segment is a different model, not a dated spelling of the same one.
  // Borrowing the elder's price ranks it on a guess; `unpriced` is honest.
  equal(resolveRatePrice({ "claude-sonnet-5": { input: 2, output: 10 } }, "claude-sonnet-5-5"), null,
    "RED: an unpublished model borrowed a sibling's price");
  equal(resolveRatePrice({ "gpt-5": { input: 1, output: 2 } }, "gpt-5-codex"), null);
  equal(resolveRatePrice(dated, "claude-sonnet-5-5"), null);
});
