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

// Which host's tree an install path sits in. The directory the host keeps its
// plugins under is the marker — `.claude`, `.codex` — because that is the thing
// that differs between hosts and the thing an install path is made of. A source
// checkout matches nothing, which is the right answer: it says nothing about what
// is running it.
const HOST_DIRS = [["claude", ".claude"], ["codex", ".codex"]];

export function hostFromInstallPath(installPath) {
  const segments = String(installPath || "").split(/[\\/]/);
  for (const [host, dir] of HOST_DIRS) if (segments.includes(dir)) return host;
  return "unknown";
}

// The host swarm is running inside: `claude`, `codex`, or `unknown`.
//
// Where this copy is INSTALLED is the evidence — the honest signal, and the one
// available when the operator types `swarm config init`, which no host wraps in a
// hook (CLAUDE_PLUGIN_ROOT is only set for the hooks the host itself invokes).
// SWARM_HOST stays as the explicit override for a host swarm cannot see yet, and
// the CLAUDECODE marker stays as the fallback where the registry is unreadable —
// its VALUE, not the key's presence, because a stray CLAUDECODE=0 would otherwise
// turn a provider on by accident.
export function detectHost(env = process.env, { installed = resolveInstalled({ registry: registryPath(env) }) } = {}) {
  const declared = env?.SWARM_HOST;
  if (declared !== undefined) return HOSTS.has(declared) ? declared : "unknown";
  const fromPath = hostFromInstallPath(installed?.installPath);
  if (fromPath !== "unknown") return fromPath;
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
