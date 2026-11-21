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
// a cached 100% may describe a window that has since reset. Every other reading
// warns only when `provenanceBanner` flags it: that function is the one place
// that decides a figure is untrustworthy, and a fresh in-TTL cache is not.
// Nothing on `unknown` without provenance (the provider is off).
//
// `defendedBy` is the leaf's resolved fallback: the scheduler moves a `quota` leaf
// onto it, so a non-Ollama one turns the refusal into a warning. An Ollama fallback
// draws on the same exhausted allowance and does not defend.
export function checkHeadroom(provider, model, l, headroom, errors, warnings, { defendedBy } = {}) {
  if (provider !== "ollama") return;
  if (headroom?.state === "exhausted" && headroom?.provenance === "live") {
    const resets = formatResetTime(headroom.resetsAt) ?? headroom.resetsAt;
    // Goes red on: a live-exhausted ollama primary whose fallback is claude/codex.
    if (defendedBy && defendedBy.provider !== "ollama") {
      warnings?.push(
        `${l}: ':cloud' weekly allowance is exhausted (${headroom.weeklyPctUsed}%, resets ${resets}) — ` +
        `runs on its fallback ${defendedBy.provider}/${defendedBy.model}`
      );
      return;
    }
    errors.push(
      `${l}: seats ':cloud' model '${model}', but the weekly allowance is exhausted ` +
      `(${headroom.weeklyPctUsed}%, resets ${resets}) — every :cloud leaf will park in ` +
      `\`quota\`. Recast these leaves onto Claude tiers, or re-run after the reset.`
    );
    return;
  }
  // Nothing task-specific in it, so it is one line per manifest however many
  // :cloud seats and fallbacks the manifest has.
  const banner = warnings ? provenanceBanner(headroom) : [];
  const warning = `the weekly-allowance figure for :cloud seats is not live — ${banner.join(" ")}`;
  if (banner.length && !warnings.includes(warning)) warnings.push(warning);
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
