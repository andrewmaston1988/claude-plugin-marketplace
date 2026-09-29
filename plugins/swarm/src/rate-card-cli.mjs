// `swarm refresh-prices` — the manual form. The CLI's wrapper: rate-card.mjs owns
// the fetching, parsing and banking, and the automatic refresh with them. It lives
// here rather than in scripts/swarm.mjs because that file is past the size at which
// a file may keep growing; `out` and `err` are passed in so the CLI keeps one writer.

import {
  RATE_CARD_SOURCES, diffPrices, loadRateCards, rateCardStorePath, refreshRateCards, reportCardChanges,
} from "./rate-card.mjs";

// The automatic refresh is rate-card.mjs's: the dashboard runs it too, and a daemon
// must not reach into a CLI module for its policy. Re-exported at this path because
// `swarm cost` imports it from here.
export { refreshStaleRateCards } from "./rate-card.mjs";
export { reportCardChanges };

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
