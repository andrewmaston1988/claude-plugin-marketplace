#!/usr/bin/env node
// GitHub merge-check hook — checks via gh whether the feature branch's PR is merged.
// Exit 0 = merged (row advances to done), non-0 = not merged / unknown.
//
// Wired by the setup wizard at ~/.pipeline/hooks/merge-check.mjs and referenced
// from cfg.hooks.merge_check. The orchestrator's cleanupMergedRows pass spawns
// this once per row at stage=merge on every 30s poll, so windowsHide:true is
// load-bearing on Windows — without it gh.exe pops a console window each call.
import { spawnSync } from "node:child_process";

const branch = process.env.PIPELINE_BRANCH;
const root   = process.env.PIPELINE_PROJECT_ROOT;

const r = spawnSync(
  "gh", ["pr", "view", branch, "--json", "state", "--jq", ".state"],
  { cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true },
);
process.exit(r.stdout?.trim() === "MERGED" ? 0 : 1);
