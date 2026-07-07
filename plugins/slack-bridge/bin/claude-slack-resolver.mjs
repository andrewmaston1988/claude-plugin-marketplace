#!/usr/bin/env node
// Self-resolving claude-slack shim (mirrors pipeline-resolver.mjs).
//
// Setup copies this file to a stable location (~/.local/bin) and points the OS
// autostart entry at it. Plugin updates change the sha-versioned cache dir on
// every marketplace update; this shim looks up the currently-active install in
// ~/.claude/plugins/installed_plugins.json on each launch and dispatches to its
// bin/claude-slack.mjs — the autostart entry never needs to change again.
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN_NAME = "slack-bridge";
const REGISTRY = join(homedir(), ".claude", "plugins", "installed_plugins.json");

// Pure so it is unit-testable: pick the active install path for a plugin name,
// across whichever marketplace it was installed from. Prefer user scope; among
// ties, most recently updated wins.
export function resolveInstallPath(registry, pluginName = PLUGIN_NAME) {
  const entries = Object.entries(registry?.plugins ?? {})
    .filter(([key]) => key.startsWith(`${pluginName}@`))
    .flatMap(([, list]) => list ?? []);
  if (!entries.length) return null;
  const userScoped = entries.filter((e) => e.scope === "user");
  const pool = userScoped.length ? userScoped : entries;
  pool.sort((a, b) => (b.lastUpdated || "").localeCompare(a.lastUpdated || ""));
  return pool[0]?.installPath ?? null;
}

function die(msg) {
  process.stderr.write(`claude-slack: ${msg}\n`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!existsSync(REGISTRY)) die(`registry not found at ${REGISTRY}`);
  let registry;
  try { registry = JSON.parse(readFileSync(REGISTRY, "utf8")); }
  catch (e) { die(`cannot parse ${REGISTRY}: ${e.message}`); }

  const installPath = resolveInstallPath(registry);
  if (!installPath) die(`${PLUGIN_NAME} not installed (no entry in ${REGISTRY})`);

  const binPath = join(installPath, "bin", "claude-slack.mjs");
  if (!existsSync(binPath)) die(`claude-slack.mjs not found at ${binPath} — try /reload-plugins`);

  const child = spawn(process.execPath, [binPath, ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("close", (code) => process.exit(code ?? 0));
  child.on("error", (err) => die(`spawn failed: ${err.message}`));
}
