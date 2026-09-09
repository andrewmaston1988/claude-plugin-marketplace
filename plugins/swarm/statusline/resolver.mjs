#!/usr/bin/env node
// Self-resolving shim for anything this plugin ships. `swarm statusline install` and
// `swarm serve install-autostart` copy this file to a STABLE path under ~/.swarm/ and
// point settings.json / the Windows Startup launcher there — never at the plugin's
// sha-versioned cache dir, which changes on every plugin update and silently strands
// whatever was pinned to it. On each invocation this looks up the active install in
// installed_plugins.json and runs the requested script from THAT.
//
//   node resolver.mjs                          statusline (default, no args)
//   node resolver.mjs <rel/path.mjs> [args…]   any script in the active install
//
// Statusline mode must never error: a failed paint prints a blank line and exits 0.
// Every other target propagates its exit code — a launcher that reports success while
// starting nothing is precisely the silent failure this shim exists to prevent.
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_KEY = "swarm@andrewmaston1988-claude-plugins";
const REGISTRY = process.env.SWARM_PLUGIN_REGISTRY || join(homedir(), ".claude", "plugins", "installed_plugins.json");

const [targetRel, ...passArgs] = process.argv.slice(2);
const statuslineMode = !targetRel;
const rel = targetRel || "statusline/swarm-statusline.mjs";

function fail(why) {
  process.stderr.write(`swarm resolver: ${why}\n`);
  if (statuslineMode) process.stdout.write("\n");
  process.exit(statuslineMode ? 0 : 1);
}

let installPath = null;
try {
  const entries = JSON.parse(readFileSync(REGISTRY, "utf8"))?.plugins?.[PLUGIN_KEY] ?? [];
  const userScoped = entries.filter((e) => e.scope === "user");
  const pool = userScoped.length ? userScoped : entries;
  pool.sort((a, b) => (b.lastUpdated || "").localeCompare(a.lastUpdated || ""));
  installPath = pool[0]?.installPath ?? null;
} catch (e) {
  fail(`cannot read ${REGISTRY}: ${e.message}`);
}
const target = installPath && join(installPath, ...rel.split("/"));
if (!target || !existsSync(target)) {
  fail(`${PLUGIN_KEY} not installed or has no ${rel} — try /reload-plugins`);
}
const r = spawnSync(process.execPath, [target, ...passArgs], { stdio: "inherit", windowsHide: true });
process.exit(r.status ?? (statuslineMode ? 0 : 1));
