// `swarm refresh-prices`, and the automatic version of it. Presentation only —
// rate-card.mjs owns the fetching, parsing and banking. It lives here rather than
// in scripts/swarm.mjs because that file is past the size at which a file may keep
// growing; `out` and `err` are passed in so the CLI keeps one writer.

import {
  RATE_CARD_FAILED_BACKOFF_HOURS, RATE_CARD_SOURCES, diffPrices, isRateCardStale,
  loadRateCards, rateCardStorePath, rateCards, readRateCardStore, refreshRateCards,
} from "./rate-card.mjs";

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
 * Rate cards come from the vendors' published tables, not from anyone retyping a
 * price. `--dry-run` parses and reports without writing — the way to check a page
 * has not moved under the parser before letting it replace a working card.
 */
export async function refreshPrices({ out, err, dryRun = false, path = rateCardStorePath(), _fetch = fetch, rosterIds } = {}) {
  if (dryRun) {
    const before = loadRateCards(path);
    for (const { provider, url, parse } of RATE_CARD_SOURCES) {
      const res = await _fetch(url);
      if (!res.ok) { err(`${provider}: ${url} -> ${res.status}`); return 1; }
      const prices = parse(await res.text());
      reportCardChanges(out, { provider, url, rows: Object.keys(prices).length, changes: diffPrices(before[provider].prices, prices) });
    }
    out("dry run — nothing written");
    return 0;
  }
  for (const summary of await refreshRateCards({ path, _fetch, rosterIds })) reportCardChanges(out, summary);
  out(`banked at ${path} — \`swarm cost\` now ranks on these`);
  return 0;
}

/**
 * No flag gates this: a stale card ranks models on prices the vendor has already
 * changed, and that is never what anyone wants. Best-effort — offline, the cached
 * card stands and its own stale banner already says so.
 *
 * The back-off is global and lives in the store, not in a caller's memory: one
 * failed read holds every surface for an hour. `rosterIds` is per provider, banked
 * with the read so a model arriving later re-prices the card.
 */
export async function refreshStaleRateCards({ out, err, path = rateCardStorePath(), _fetch = fetch, now = Date.now(), rosterIds } = {}) {
  const at = typeof now === "number" ? new Date(now) : now;
  const store = readRateCardStore(path);
  const backingOff = RATE_CARD_SOURCES.filter(({ provider }) => {
    const failedAt = Date.parse(store[provider]?.lastFailedAt ?? "");
    return Number.isFinite(failedAt) && at.getTime() - failedAt < RATE_CARD_FAILED_BACKOFF_HOURS * 3600e3;
  });
  if (backingOff.length) {
    out(`rate cards: ${backingOff.map((s) => s.provider).join(", ")} could not be read less than an hour ago — not asking again yet`);
    return { refreshed: [], failed: [], skipped: true };
  }

  const cards = rateCards(path);
  const stale = RATE_CARD_SOURCES.some(({ provider }) =>
    isRateCardStale(cards[provider], { now: at.getTime(), rosterIds: rosterIds?.[provider] }));
  if (!stale) return { refreshed: [], failed: [], skipped: true };

  try {
    const summaries = await refreshRateCards({ path, _fetch, now: at, rosterIds });
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
