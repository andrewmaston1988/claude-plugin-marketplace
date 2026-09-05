#!/usr/bin/env node
// Self-resolving statusline shim. `swarm statusline install` copies this file to
// ~/.swarm/statusline.mjs and settings.json points THERE — never at the plugin's
// sha-versioned cache dir, which changes on every plugin update. On each paint
// this looks up the active swarm install in installed_plugins.json and runs its
// statusline/swarm-statusline.mjs with stdin (the harness's session JSON) passed
// through. Any failure prints a blank line: a statusline must never error.
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_KEY = "swarm@andrewmaston1988-claude-plugins";
const REGISTRY = process.env.SWARM_PLUGIN_REGISTRY || join(homedir(), ".claude", "plugins", "installed_plugins.json");

function blank(why) {
  if (why) process.stderr.write(`swarm statusline: ${why}\n`);
  process.stdout.write("\n");
}

let installPath = null;
try {
  const entries = JSON.parse(readFileSync(REGISTRY, "utf8"))?.plugins?.[PLUGIN_KEY] ?? [];
  const userScoped = entries.filter((e) => e.scope === "user");
  const pool = userScoped.length ? userScoped : entries;
  pool.sort((a, b) => (b.lastUpdated || "").localeCompare(a.lastUpdated || ""));
  installPath = pool[0]?.installPath ?? null;
} catch (e) {
  blank(`cannot read ${REGISTRY}: ${e.message}`);
  process.exit(0);
}
const bar = installPath && join(installPath, "statusline", "swarm-statusline.mjs");
if (!bar || !existsSync(bar)) {
  blank(`${PLUGIN_KEY} not installed or has no statusline — try /reload-plugins`);
  process.exit(0);
}
const r = spawnSync(process.execPath, [bar], { stdio: ["inherit", "inherit", "inherit"], windowsHide: true });
process.exit(r.status ?? 0);
