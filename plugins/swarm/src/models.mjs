// Claude-family detection and per-tier effort matrices.

export const CLAUDE_ALIASES = new Set(["haiku", "sonnet", "opus", "fable"]);

export function isClaudeModel(model) {
  if (!model) return false;
  const m = String(model).toLowerCase();
  return m.startsWith("claude-") || CLAUDE_ALIASES.has(m);
}

// Valid --effort levels per Claude tier. Open models accept any effort —
// it passes through to the proxy and is harmlessly ignored when unsupported.
export const TIER_EFFORTS = {
  haiku:  ["low", "medium", "high"],
  sonnet: ["low", "medium", "high", "max"],
  opus:   ["low", "medium", "high", "xhigh", "max"],
  fable:  ["low", "medium", "high", "xhigh", "max"],
};

// Classify a Claude model string into a tier; tolerates dated ids
// (claude-haiku-4-5-YYYYMMDD) and bare aliases. Null when unknown.
export function tierFromModel(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  if (/haiku/.test(m))  return "haiku";
  if (/sonnet/.test(m)) return "sonnet";
  if (/opus/.test(m))   return "opus";
  if (/fable/.test(m))  return "fable";
  return null;
}

// Validate a (model, effort) pair. Open models: always valid. Claude models:
// effort must be in the tier's matrix; an unclassifiable claude-* id accepts
// any effort (future tiers must not fail validation).
export function isValidEffort(model, effort) {
  if (effort == null) return true;
  if (!isClaudeModel(model)) return true;
  const tier = tierFromModel(model);
  if (!tier) return true;
  return TIER_EFFORTS[tier].includes(effort);
}
