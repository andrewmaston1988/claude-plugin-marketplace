// `swarm refresh-prices`, and the automatic version of it. Presentation only —
// rate-card.mjs owns the fetching, parsing and banking. It lives here rather than
// in scripts/swarm.mjs because that file is past the size at which a file may keep
// growing; `out` and `err` are passed in so the CLI keeps one writer.

import {
  RATE_CARD_SOURCES, diffPrices, isRateCardStale, loadRateCards,
  rateCardStorePath, refreshRateCards,
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
export async function refreshPrices({ out, err, dryRun = false, path = rateCardStorePath(), _fetch = fetch } = {}) {
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
  for (const summary of await refreshRateCards({ path, _fetch })) reportCardChanges(out, summary);
  out(`banked at ${path} — \`swarm cost\` now ranks on these`);
  return 0;
}

/**
 * No flag gates this: a stale card ranks models on prices the vendor has already
 * changed, and that is never what anyone wants. Best-effort — offline, the cached
 * card stands and its own stale banner already says so.
 */
export async function refreshStaleRateCards({ out, err, path = rateCardStorePath(), _fetch = fetch } = {}) {
  if (!Object.values(loadRateCards(path)).some((card) => isRateCardStale(card))) return;
  try {
    for (const summary of await refreshRateCards({ path, _fetch })) {
      if (summary.changes.length) reportCardChanges(out, summary);
    }
  } catch (e) {
    err(`rate cards are stale and could not be refreshed (${e.message}) — ranking on the cached table`);
  }
}
