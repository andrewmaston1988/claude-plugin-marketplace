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

export async function costSettings(cfg = getConfig()) {
  const ollama = providerConfig(cfg, "ollama");
  return { bands: await costBands(cfg), valueMargin: ollama?.cloud?.ollama?.valueMargin, cloudSuffix: cloudSuffixOf(cfg) };
}
