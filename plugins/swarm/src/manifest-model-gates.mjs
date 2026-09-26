// The gates a seated model must pass before a leaf may run on it: provider
// identity resolution, effort support, the machine-wide denylist, and the
// weekly-allowance headroom reading for `:cloud` seats.

import { isValidEffort } from "./models.mjs";
import { provenanceBanner, formatResetTime } from "./usage.mjs";
import { defaultProviderRegistry } from "./default-providers.mjs";

export const PROVIDERS = defaultProviderRegistry();

// Denylist — takes a model out of circulation machine-wide. Case-insensitive
// substring so the config author controls precision ("nemotron" bans the
// family; a full name bans exactly one). Returns the matching entry for the
// error message, undefined when clear. Shared with the CLI's roster filter.
export function matchDenylist(model, cfg) {
  const lower = String(model || "").toLowerCase();
  return (cfg?.modelDenylist || []).find(
    (e) => typeof e === "string" && e && lower.includes(e.toLowerCase())
  );
}

export function checkDenylist(model, l, cfg, errors) {
  const hit = matchDenylist(model, cfg);
  if (hit) {
    errors.push(
      `${l}: model '${model}' is denylisted in config (matched '${hit}') — remove it from ` +
      `modelDenylist in ~/.swarm/config.json or pick another model; see 'swarm models'`
    );
  }
}

// Weekly-allowance headroom gate for `:cloud` seats. Sits beside the
// governance rejection — reported after it, since a cwd that isn't even
// allowed to dispatch open models is the more fundamental rejection.
// FAILS only on a LIVE `exhausted` — the leaf would only park in `quota`, and
// a cached 100% may describe a window that has since reset. Any other
// non-live reading (cached, none) WARNS with the banner text: the figure
// still shows, but no reader mistakes it for a fetch that just happened.
// Nothing on `unknown` without provenance (the provider is off).
export function checkHeadroom(provider, model, l, headroom, errors, warnings) {
  if (provider !== "ollama") return;
  if (headroom?.state === "exhausted" && headroom?.provenance === "live") {
    const resets = formatResetTime(headroom.resetsAt) ?? headroom.resetsAt;
    errors.push(
      `${l}: seats ':cloud' model '${model}', but the weekly allowance is exhausted ` +
      `(${headroom.weeklyPctUsed}%, resets ${resets}) — every :cloud leaf will park in ` +
      `\`quota\`. Recast these leaves onto Claude tiers, or re-run after the reset.`
    );
  } else if (headroom?.provenance && headroom.provenance !== "live" && warnings) {
    const banner = provenanceBanner(headroom);
    warnings.push(
      `${l}: seats ':cloud' model '${model}', but the weekly-allowance figure is not live — ` +
      (banner.length ? banner.join(" ") : "run `swarm ollama-usage` to refresh it before trusting this run.")
    );
  }
}

export function resolveProvider(task, cfg, cache, l, errors, providerRegistry = PROVIDERS) {
  try {
    const identity = providerRegistry.resolve(task, { cache, config: cfg });
    const adapter = providerRegistry.get(identity.provider);
    const problems = adapter.validateTask({ ...task, ...identity }, { config: cfg });
    for (const problem of problems || []) errors.push(`${l}: ${problem}`);
    return identity;
  } catch (e) {
    errors.push(`${l}: ${e.message}`);
    return null;
  }
}

export function validateEffort(model, provider, effort, declared, l, errors) {
  if (!isValidEffort(model, effort, declared)) {
    errors.push(`${l}: effort '${effort}' is not supported by ${model} (${provider} declares: ${declared.efforts.join(", ")})`);
  }
}
