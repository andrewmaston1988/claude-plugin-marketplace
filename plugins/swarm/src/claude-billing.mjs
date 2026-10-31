// Anthropic API-credit billing for one leaf. Claude Code resolves credentials by
// precedence, and every name below outranks an API key — a parent shell wrapping another
// endpoint exports the first two. A billed leaf therefore clears them in
// `--settings` (the only route above the shell and settings.json) and receives the key
// in its own child env, which is the one place a key never reaches argv.
export const CLAUDE_ROUTING_ENV = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

// Every variable a leaf's credential is decided by. A task or config may not name these.
export const CLAUDE_CREDENTIAL_ENV = ["ANTHROPIC_API_KEY", ...CLAUDE_ROUTING_ENV];

// A dedicated variable, never ANTHROPIC_API_KEY: runTask spreads the parent env into
// every leaf, so exporting the key under that name would move subscription leaves too.
export const DEFAULT_API_KEY_ENV = "SWARM_ANTHROPIC_API_KEY";

export function isApiBilled(task) {
  return task?.billing === "api";
}

export function apiKeyEnvName(cfg) {
  return cfg?.providers?.claude?.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
}

// Returns a fresh settings object — callers pass a merged payload that is also the
// task's own, and mutating it would leak the cleared vars into the next dispatch.
export function applyBillingRouting(settings) {
  const out = { ...(settings ?? {}) };
  out.env = { ...(out.env ?? {}) };
  for (const key of CLAUDE_ROUTING_ENV) out.env[key] = "";
  return out;
}

// The child's env override. Absent unless the task opted in; an empty value fails
// before the spawn and names the variable, never the value.
export function billingSpawnEnv(task, cfg, env = process.env) {
  if (!isApiBilled(task)) return {};
  const name = apiKeyEnvName(cfg);
  const value = env?.[name];
  if (!value) {
    throw new Error(`billing "api" needs a key in ${name} — set it in the environment that launches swarm; the engine never prints the value`);
  }
  return { ANTHROPIC_API_KEY: value };
}
