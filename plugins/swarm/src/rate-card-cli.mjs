// `swarm refresh-prices` — the manual form. The CLI's wrapper: rate-card.mjs owns
// the fetching, parsing and banking, and the automatic refresh with them. It lives
// here rather than in scripts/swarm.mjs because that file is past the size at which
// a file may keep growing; `out` and `err` are passed in so the CLI keeps one writer.

import {
  diffPrices, loadRateCards, rateCardSourcesFor, rateCardStorePath, refreshRateCards, reportCardChanges,
} from "./rate-card.mjs";

// The automatic refresh is rate-card.mjs's: the dashboard runs it too, and a daemon
// must not reach into a CLI module for its policy. Re-exported at this path because
// `swarm cost` imports it from here.
export { refreshStaleRateCards } from "./rate-card.mjs";
export { reportCardChanges };

/**
 * Rate cards come from the vendors' published tables, not from anyone retyping a
 * price. `--dry-run` parses and reports without writing — the way to check a page
 * has not moved under the parser before letting it replace a working card. Only the
 * `enabled` providers' pages are read; with none, it says so without naming a vendor.
 */
export async function refreshPrices({ out, err, dryRun = false, path = rateCardStorePath(), _fetch = fetch, rosterIds, enabled } = {}) {
  const providers = rateCardSourcesFor(enabled);
  if (!providers.length) { out("no enabled provider publishes a price table — nothing to refresh"); return 0; }
  if (dryRun) {
    const before = loadRateCards(path);
    for (const { provider, url, parse } of providers) {
      const res = await _fetch(url);
      if (!res.ok) { err(`${provider}: ${url} -> ${res.status}`); return 1; }
      const prices = parse(await res.text());
      reportCardChanges(out, { provider, url, rows: Object.keys(prices).length, changes: diffPrices(before[provider].prices, prices) });
    }
    out("dry run — nothing written");
    return 0;
  }
  for (const summary of await refreshRateCards({ path, _fetch, rosterIds, providers })) reportCardChanges(out, summary);
  out(`banked at ${path} — \`swarm cost\` now ranks on these`);
  return 0;
}
