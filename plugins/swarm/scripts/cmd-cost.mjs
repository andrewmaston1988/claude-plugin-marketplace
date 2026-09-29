// `swarm cost` — split out of swarm.mjs, which now just dispatches to it, the same
// shape as cmd-serve.mjs. The cost modules stay lazily imported inside the command,
// so no other subcommand pays for loading them.
import { getConfig } from "../src/config.mjs";
import { modelRoster } from "../src/roster.mjs";
import { defaultProviderRegistry } from "../src/default-providers.mjs";
import { enabledProviderIds, providerConfig } from "../src/providers.mjs";
import { dim, out, err } from "../src/ui.mjs";

// swarm cost — one list per provider, cheapest → dearest within each. The
// sections are never merged and never cross-ranked: a measured Ollama meter
// point and a published Codex price do not share an axis. The Ollama section is
// the meter's own table, ported field-for-field from the operator-side
// cost-table.mjs so the two can be read side by side; the other sections are
// static rate cards (see cost.mjs), and a model absent from one is an `unpriced`
// row rather than a blank.
export async function cmdCost() {
  const cfg = getConfig();
  const registry = defaultProviderRegistry();
  const roster = modelRoster({ config: cfg, registry }).models;
  const enabled = enabledProviderIds(cfg, registry);
  const {
    costSections, costProvidersFor, readSnapshots, usageHistoryPath, THIN_REQUESTS, modelsByProvider,
    METER_PROVIDER, METER_POINTS_UNIT, UNPRICED_CLASSIFICATION, API_EQUIVALENT_CLASSIFICATION,
  } = await import("../src/cost.mjs");
  // The roster is what the cards are priced for: a model that arrives between
  // refreshes is one the banked card has never seen, and it re-prices rather than
  // ranking `unpriced` for half a day.
  await (await import("../src/rate-card-cli.mjs")).refreshStaleRateCards({
    out, err, rosterIds: modelsByProvider(roster), enabled,
  });
  const path = usageHistoryPath();
  const snaps = readSnapshots(path);
  const sections = costSections({
    providers: costProvidersFor(enabled), models: modelsByProvider(roster), snaps,
    cloudSuffix: providerConfig(cfg, "ollama")?.cloudSuffix,
  });
  out("cost — one list per provider, cheapest to dearest within each. The units are not comparable across sections.");
  out("");
  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  for (const section of sections) {
    for (const line of [`── ${section.provider} — ${section.unit}`, ...section.banner]) out(line);
    if (!section.rows.length) {
      out(section.provider === METER_PROVIDER
        ? `   no cost history yet at ${path} — every live usage fetch banks one snapshot; a fresh install fills within a week`
        : "   no models to list — the roster names none, and the table prices none");
      out("");
      continue;
    }
    out("   " + pad("model", 26) + num("reqs", 7) + num("wks", 5) + num("pts/req", 10) + num("cost", 8) + "  notes");
    for (const r of section.rows) {
      const notes = [];
      // A meter row's `unpriced` means "this list is not denominated in money at
      // all" — say the meter's own reason, never the rate card's.
      if (r.unit === METER_POINTS_UNIT) {
        if (r.ptsPerReq == null) notes.push("share below the page's 0.1% resolution — not measurable");
        else if (r.measuredRequests < THIN_REQUESTS) notes.push(`thin (${r.measuredRequests} req)`);
        if (r.ptsPerReq != null && r.measuredRequests < r.requests) {
          notes.push(`${r.requests - r.measuredRequests} of ${r.requests} req in weeks below resolution`);
        }
      } else if (r.classification === UNPRICED_CLASSIFICATION) {
        notes.push("unpriced — no published price in the table");
      } else if (r.classification === API_EQUIVALENT_CLASSIFICATION) {
        notes.push("api-equivalent estimate, not money spent");
      }
      // Inferred from a family tier rather than read off the table — say so, or
      // it reads as sourced.
      if (r.pricedVia) notes.push(`family tier, priced as ${r.pricedVia}`);
      out(
        "   " + pad(r.model, 26) +
        num(r.requests ?? "—", 7) +
        num(r.weeks ?? "—", 5) +
        num(r.ptsPerReq != null ? r.ptsPerReq.toFixed(5) : "—", 10) +
        num(r.mult != null ? r.mult.toFixed(1) + "x" : "—", 8) +
        (notes.length ? "  " + notes.join(", ") : "")
      );
    }
    if (section.hidden) out(dim(`${section.hidden} superseded hidden — the newest of each family is the one priced here`));
    out("");
  }
  out("Read beside `swarm perf` — that owns quality, this owns cost. Each section ranks within itself; no section is ever ranked against another.");
  return 0;
}
