// Which agent host swarm is running inside, and where the plugin registry lives. Both were
// spelled inline in more than one place before (statusline/resolver.mjs, serve/daemon.mjs),
// and mirrors drift. resolver.mjs is copied to a stable path and imports only builtins, so
// it cannot import this module: it keeps its own copy on purpose, carried by hand.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PLUGIN_KEY = "swarm@andrewmaston1988-claude-plugins";

export const registryPath = (env = process.env) =>
  env.SWARM_PLUGIN_REGISTRY || join(homedir(), ".claude", "plugins", "installed_plugins.json");

// { installPath, version } of the active swarm entry, or null. Never throws: an
// unreadable or mid-write registry is "unknown", and unknown must never move a
// daemon.
export function resolveInstalled({ registry = registryPath(), readFile = readFileSync } = {}) {
  try {
    const entries = JSON.parse(readFile(registry, "utf8"))?.plugins?.[PLUGIN_KEY] ?? [];
    const userScoped = entries.filter((e) => e.scope === "user");
    const pool = userScoped.length ? userScoped : entries;
    pool.sort((a, b) => (b.lastUpdated || "").localeCompare(a.lastUpdated || ""));
    return pool[0]?.installPath ? { installPath: pool[0].installPath, version: pool[0].version ?? null } : null;
  } catch { return null; }
}

const HOSTS = new Set(["claude", "codex"]);

// The host swarm is running inside: `claude`, `codex`, or `unknown`. The VALUE of
// CLAUDECODE is the test, not the key's presence — a stray CLAUDECODE=0 would otherwise
// turn a provider on by accident. Codex has no marker swarm can see yet
// (codex-plugin-surface's job), so SWARM_HOST names the host by hand until then.
export function detectHost(env = process.env) {
  const declared = env?.SWARM_HOST;
  if (declared !== undefined) return HOSTS.has(declared) ? declared : "unknown";
  if (env?.CLAUDECODE === "1") return "claude";
  return "unknown";
}

// Providers the host can dispatch natively — what setup offers to turn on for a
// fresh install, so the shipped default stops deciding this for a machine it has
// never met. An unknown host recommends NOTHING: the caller asks the operator
// rather than enabling a provider on a guess.
export function hostProviders(host) {
  return HOSTS.has(host) ? [host] : [];
}
