#!/usr/bin/env node
// Self-resolving shim for anything this plugin ships. `swarm statusline install` and
// `swarm serve install-autostart` copy this file to a STABLE path under ~/.swarm/ and
// point settings.json / the Windows Startup launcher there — never at the plugin's
// sha-versioned cache dir, which changes on every plugin update and silently strands
// whatever was pinned to it. On each invocation this looks up the active install and
// runs the requested script from THAT.
//
//   node resolver.mjs                          statusline (default, no args)
//   node resolver.mjs <rel/path.mjs> [args…]   any script in the active install
//
// Statusline mode must never error: a failed paint prints a blank line and exits 0.
// Every other target propagates its exit code — a launcher that reports success while
// starting nothing is precisely the silent failure this shim exists to prevent.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// One key for both hosts: the Codex marketplace index reuses the Claude marketplace's
// name, so `swarm@<marketplace>` is the same string wherever it is installed.
const PLUGIN_KEY = "swarm@andrewmaston1988-claude-plugins";
const REGISTRY_OVERRIDE = process.env.SWARM_PLUGIN_REGISTRY;
const REGISTRY = REGISTRY_OVERRIDE || join(homedir(), ".claude", "plugins", "installed_plugins.json");

const [targetRel, ...passArgs] = process.argv.slice(2);
const statuslineMode = !targetRel;
const rel = targetRel || "statusline/swarm-statusline.mjs";

function fail(why) {
  process.stderr.write(`swarm resolver: ${why}\n`);
  if (statuslineMode) process.stdout.write("\n");
  process.exit(statuslineMode ? 0 : 1);
}

function claudeInstall() {
  if (!existsSync(REGISTRY)) return null;
  const entries = JSON.parse(readFileSync(REGISTRY, "utf8"))?.plugins?.[PLUGIN_KEY] ?? [];
  const userScoped = entries.filter((e) => e.scope === "user");
  const pool = userScoped.length ? userScoped : entries;
  pool.sort((a, b) => (b.lastUpdated || "").localeCompare(a.lastUpdated || ""));
  return pool[0]?.installPath ?? null;
}

// Codex ships no registry file. An install is a directory under
// ~/.codex/plugins/cache/<marketplace>/<name>/<version>/, switched on by a config.toml
// table. Sliced by hand rather than parsed: one table is all that is read, and the
// zero-runtime-dependency rule forbids pulling a TOML parser in for it.
function codexInstall() {
  const [name, marketplace] = PLUGIN_KEY.split("@");
  const config = join(homedir(), ".codex", "config.toml");
  if (!existsSync(config)) return null;
  const header = `[plugins."${PLUGIN_KEY}"]`;
  const text = readFileSync(config, "utf8");
  const at = text.indexOf(header);
  if (at < 0) return null;
  // Stop at the next table header, or a later table's `enabled = true` would
  // switch this plugin on.
  const table = text.slice(at + header.length).split("\n[")[0];
  if (!/^\s*enabled\s*=\s*true\s*$/m.test(table)) return null;

  const base = join(homedir(), ".codex", "plugins", "cache", marketplace, name);
  if (!existsSync(base)) return null;
  // Newest by mtime, never by version string — the version dirs Codex mints in
  // practice are "0.1.0", "26.911.61220" and a bare sha, which share no ordering.
  const installs = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(base, e.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return installs[0] ?? null;
}

// An explicit SWARM_PLUGIN_REGISTRY names a Claude-shaped registry file, so honouring
// it means not falling through to a Codex install the operator did not point at.
const hosts = [["claude", claudeInstall, REGISTRY]];
if (!REGISTRY_OVERRIDE) hosts.push(["codex", codexInstall, join(homedir(), ".codex", "config.toml")]);

let installPath = null;
const tried = [];
for (const [host, find, where] of hosts) {
  try {
    installPath = find();
    if (installPath) break;
    tried.push(`${host}: no install in ${where}`);
  } catch (e) {
    tried.push(`${host}: ${where}: ${e.message}`);
  }
}

const target = installPath && join(installPath, ...rel.split("/"));
if (!target || !existsSync(target)) {
  const why = installPath ? `has no ${rel}` : `not installed (${tried.join("; ")})`;
  fail(`${PLUGIN_KEY} ${why} — try /reload-plugins`);
}
const r = spawnSync(process.execPath, [target, ...passArgs], { stdio: "inherit", windowsHide: true });
// A null status means the child died without one — killed by signal, or never
// spawned. Statusline mode swallows that by contract; every other caller is a
// CLI whose exit code is read, so say what happened and fail.
if (r.status == null && !statuslineMode) {
  process.stderr.write(`swarm resolver: ${rel} ended without an exit code${r.error ? ` (${r.error.message})` : r.signal ? ` (killed by ${r.signal})` : ""}\n`);
}
process.exit(r.status ?? (statuslineMode ? 0 : 1));
