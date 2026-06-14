#!/usr/bin/env node
// Self-resolving pipeline CLI shim.
//
// The setup wizard copies this file to <user-bin>/pipeline-resolver.mjs and
// writes thin bash + .cmd wrappers next to it that just exec node against this
// script. The wrappers' paths never need to change. This resolver looks up the
// currently-active pipeline install in `~/.claude/plugins/installed_plugins.json`
// on every invocation and dispatches to its `bin/pipeline.mjs`. Survives any
// number of /reload-plugins sha bumps without re-running setup.
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_KEY = "pipeline@andrewmaston1988-claude-plugins";
const REGISTRY   = join(homedir(), ".claude", "plugins", "installed_plugins.json");

function die(msg) {
  process.stderr.write(`pipeline: ${msg}\n`);
  process.exit(1);
}

if (!existsSync(REGISTRY)) die(`registry not found at ${REGISTRY}`);

let registry;
try { registry = JSON.parse(readFileSync(REGISTRY, "utf8")); }
catch (e) { die(`cannot parse ${REGISTRY}: ${e.message}`); }

const entries = registry?.plugins?.[PLUGIN_KEY] ?? [];
if (!entries.length) die(`${PLUGIN_KEY} not installed (no entries in ${REGISTRY})`);

// Prefer user-scope; fall back to first. Among ties, take most-recently-updated.
const userScoped = entries.filter(e => e.scope === "user");
const pool = userScoped.length ? userScoped : entries;
pool.sort((a, b) => (b.lastUpdated || "").localeCompare(a.lastUpdated || ""));
const installPath = pool[0]?.installPath;
if (!installPath) die(`${PLUGIN_KEY} entry has no installPath`);

const binPath = join(installPath, "bin", "pipeline.mjs");
if (!existsSync(binPath)) die(`pipeline.mjs not found at ${binPath} — try /reload-plugins`);

const child = spawn(process.execPath, [binPath, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("close", code => process.exit(code ?? 0));
child.on("error", err => die(`spawn failed: ${err.message}`));
