import { getConfig } from "./config.mjs";
import { providerConfig } from "./providers.mjs";
import { resolveBands } from "./cost.mjs";

// The cached roster, grouped by provider — what `swarm cost` asks each provider
// to price. A model the table does not list still gets a row, marked unpriced.
// Band edges, the value margin and the cloud suffix are config, shared with the
// dashboard's server — one source, never two.
export async function costBands(cfg = getConfig()) {
  return resolveBands(providerConfig(cfg, "ollama")?.cloud?.ollama?.costBands);
}

export const cloudSuffixOf = (cfg) => providerConfig(cfg, "ollama")?.cloudSuffix || ":cloud";

// The OLLAMA METER rows, for joins against the Ollama roster and the dispatch
// frontier. Deliberately not the provider walk: `swarm perf` and the seat report
// rank on the meter's own axis and its bands, and a published-price weight from
// another provider's rate card would be a cross-provider rank — the one thing
// the units forbid. `swarm cost` asks cost.mjs for all three lists instead.
//
// The history banks the meter's own names (the page's `data-model`);
// deriveCloudName is the same mapping discovery uses — never a second rule. Both
// reads are cheap and a missing file reads as empty, so a fresh install is
// simply "unmeasured".
export async function meterCostRows(env = process.env) {
  const { ollamaCloudCostRows, readSnapshots, usageHistoryPath } = await import("./cost.mjs");
  return ollamaCloudCostRows(readSnapshots(usageHistoryPath(env)));
}

export async function costSettings(cfg = getConfig()) {
  const ollama = providerConfig(cfg, "ollama");
  return { bands: await costBands(cfg), valueMargin: ollama?.cloud?.ollama?.valueMargin, cloudSuffix: cloudSuffixOf(cfg) };
}
