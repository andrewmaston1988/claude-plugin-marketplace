#!/usr/bin/env node
// Nudge hook: after a Bash/PowerShell call that can move HEAD, name any finished run
// this session has just fully ported, with the prune command that frees it.
// Silent (exit 0) in a leaf, an autonomous session, with the setting off, with no
// session id, on unparseable stdin, outside a repo, or on any other tool or event.
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadConfig, swarmHome } from "../src/config.mjs";
import { makeGit } from "../src/prune.mjs";
import { isPortPayload, runPortNudge } from "../src/port-nudge.mjs";

async function main() {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) stdin += c;
  let payload;
  try { payload = JSON.parse(stdin); } catch { process.exit(0); }
  // Before the config read: this hook fires on every tool call the session makes.
  if (!isPortPayload(payload, process.env)) process.exit(0);
  let config;
  try { config = loadConfig(undefined, process.env); } catch { process.exit(0); }

  const output = runPortNudge({
    payload,
    env: process.env,
    config,
    home: swarmHome(process.env),
    git: makeGit(spawnSync),
    spawn: spawnSync,
    fs,
    budgetMs: 20_000,
  });
  if (output) process.stdout.write(output);
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}
