// Claude-family detection and provider-declared effort capabilities.

import { identityKey, OLLAMA_CLOUD_RE } from "./contracts.mjs";

export { CLAUDE_ALIASES, isClaudeModel } from "./contracts.mjs";

// Both separators occur in the roster — discovery derives `:cloud` names from
// bare tags, and the entitlement probe matches either. Single home: the score
// store and the run-enumeration helper must agree on which leaves are gradeable.
export function isCloudModel(model) {
  return OLLAMA_CLOUD_RE.test(String(model || ""));
}

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

// Validate only what the model's provider has declared. An absent declaration
// cannot contradict an effort, so unknown and undeclared models pass through.
export function isValidEffort(_model, effort, declared) {
  if (effort == null) return true;
  const efforts = Array.isArray(declared) ? declared : declared?.efforts;
  return !Array.isArray(efforts) || efforts.length === 0 || efforts.includes(effort);
}

export function effortFor(task, declared) {
  return task.effort ?? declared?.defaultEffort ?? "medium";
}

export function declaredEfforts(model, provider, cache = []) {
  const entries = new Map();
  for (const row of cache || []) {
    if (!row?.model) continue;
    entries.set(identityKey(row), row);
    entries.set(row.model, row);
  }
  const row = entries.get(identityKey({ model, provider })) || entries.get(model);
  if (!row) return undefined;
  const declared = {};
  if (Array.isArray(row.efforts) && row.efforts.length) declared.efforts = row.efforts;
  if (typeof row.defaultEffort === "string" && row.defaultEffort.trim()) declared.defaultEffort = row.defaultEffort;
  return Object.keys(declared).length ? declared : undefined;
}
