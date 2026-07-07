#!/usr/bin/env node
// swarm CLI — thin argv layer over src/. Subcommands: models | validate | run.
// stdout carries status lines + paths only, never raw task output.
import { loadConfig } from "../src/config.mjs";
import { loadManifest, ValidationError } from "../src/manifest.mjs";
import { discoverModels, writeModelsCache } from "../src/discovery.mjs";
import { runPlan, makeDefaultIo } from "../src/scheduler.mjs";
import { formatClosing, renderStatus } from "../src/results.mjs";

const USAGE = `usage: swarm.mjs <command>
  models                     list launchable :cloud models (+ Claude aliases)
  validate <manifest.json>   lint a manifest; exit 1 with readable errors
  run <manifest.json> [--force]   execute the plan (use Bash run_in_background)
  status <resultsDir>        one-shot progress view of a run (reads run.log)`;

// Always-available Claude aliases, appended after discovered models.
const CLAUDE_ALIASES = [
  { model: "haiku", description: "Claude Haiku — always available" },
  { model: "sonnet", description: "Claude Sonnet — always available" },
  { model: "opus", description: "Claude Opus — always available" },
];

function out(line) {
  process.stdout.write(line + "\n");
}

function err(line) {
  process.stderr.write(line + "\n");
}

function getConfig() {
  return loadConfig(process.env.SWARM_CONFIG);
}

async function cmdModels() {
  const cfg = getConfig();
  const models = await discoverModels(cfg);
  writeModelsCache(models);
  for (const m of [...models, ...CLAUDE_ALIASES]) {
    out(m.description ? `${m.model} — ${m.description}` : m.model);
  }
  return 0;
}

function cmdValidate(manifestPath) {
  const cfg = getConfig();
  const plan = loadManifest(manifestPath, cfg, process.cwd());
  out(`manifest OK: ${plan.tasks.length} task(s)${plan.digest ? " + digest" : ""}`);
  out(`resultsDir: ${plan.resultsDir}`);
  return 0;
}

async function cmdRun(manifestPath, force) {
  const cfg = getConfig();
  const plan = loadManifest(manifestPath, cfg, process.cwd());
  const io = makeDefaultIo();
  const r = await runPlan(plan, cfg, io, { force });

  out(formatClosing({
    digestPath: r.digestPath,
    digestFailed: r.digestFailed,
    summaryPath: r.summaryPath,
    worktreesKept: r.worktreesKept,
  }));

  const bad = r.summary.tasks.filter((t) => !["ok", "skipped"].includes(t.state) && t.id !== "__digest");
  if (bad.length) {
    out(`FAILED tasks: ${bad.map((t) => `${t.id} [${t.state}]`).join(", ")}`);
    out("resume: re-run the same command — ok results are skipped, failed/blocked work re-executes.");
    return 1;
  }
  // A digest failure alone never blocks result availability — the run is done;
  // the session falls back to summary.json + selective raw reads.
  return 0;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "models":
        return await cmdModels();
      case "validate": {
        if (!rest[0]) { err(USAGE); return 1; }
        return cmdValidate(rest[0]);
      }
      case "run": {
        if (!rest[0]) { err(USAGE); return 1; }
        return await cmdRun(rest[0], rest.includes("--force"));
      }
      case "status": {
        if (!rest[0]) { err(USAGE); return 1; }
        out(renderStatus(rest[0]));
        return 0;
      }
      default:
        err(USAGE);
        return 1;
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      err("manifest validation failed:");
      for (const line of e.errors) err(`  - ${line}`);
    } else {
      err(`swarm: ${e.message}`);
    }
    return 1;
  }
}

process.exit(await main());
