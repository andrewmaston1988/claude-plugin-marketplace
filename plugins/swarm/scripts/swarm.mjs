#!/usr/bin/env node
// swarm CLI — thin argv layer over src/. Subcommands: models | validate | run.
// stdout carries status lines + paths only, never raw task output.
import { join } from "node:path";
import { loadConfig, swarmHome } from "../src/config.mjs";
import { loadManifest, ValidationError } from "../src/manifest.mjs";
import { discoverModels, writeModelsCache } from "../src/discovery.mjs";
import { runPlan, makeDefaultIo } from "../src/scheduler.mjs";
import { loadCorpus, estimateRun, formatEstimate } from "../src/estimate.mjs";
import { formatClosing, renderStatus, readResult } from "../src/results.mjs";
import { dim } from "../src/ui.mjs";

const USAGE = `usage: swarm.mjs <command>
  models                     list launchable :cloud models (+ Claude aliases)
  validate <manifest.json>   lint a manifest; exit 1 with readable errors
  run <manifest.json> [--force]   execute the plan (use Bash run_in_background)
  status <resultsDir>        one-shot progress view of a run (reads run.log)
  status <resultsDir> --watch [--interval <secs>]   live repaint until Ctrl-C
  ask <resultsDir> <taskId> "<question>" [--model <m>]   resume a finished leaf's session with a follow-up
  quota                      Anthropic subscription utilization per limit window (exit 1 when exhausted)`;

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
  // The preview IS the approval: with forEach in play, show the worst-case
  // leaf count the caps permit before anything runs.
  const fans = plan.tasks.filter((t) => t.forEach);
  const computes = plan.tasks.filter((t) => t.compute);
  if (fans.length || computes.length) {
    const leaves = plan.tasks.filter((t) => !t.compute && !t.forEach).length
      + fans.reduce((n, t) => n + t.forEach.maxItems, 0);
    const caps = fans.map((t) => `${t.id} ≤ ${t.forEach.maxItems}`).join(", ");
    out(`worst case: up to ${leaves} leaves${fans.length ? ` after forEach expansion (${caps})` : ""}${computes.length ? ` · ${computes.length} compute step(s), zero tokens` : ""}`);
  }
  // returns schemas are part of the approval surface: say which tasks are
  // guaranteed shape, and what the guarantee costs when output misses.
  const ret = plan.tasks.filter((t) => t.returns);
  if (ret.length) {
    out(`returns validated: ${ret.map((t) => t.id).join(", ")} (invalid output gets one corrective re-ask, then fails)`);
  }
  // The consent line: worst-case leaves × historical per-model medians.
  out(formatEstimate(estimateRun(plan.tasks, plan.digest, loadCorpus(join(swarmHome(), "runs")))));
  out(`resultsDir: ${plan.resultsDir}`);
  return 0;
}

async function cmdRun(manifestPath, force) {
  const cfg = getConfig();
  const plan = loadManifest(manifestPath, cfg, process.cwd());
  // Fire-and-forget notification hook (e.g. "claude-slack notify --message {status}").
  // Mechanical plumbing only: substitute tokens, spawn detached, swallow errors.
  // Shared by the end-of-run status and the scheduler's single-shot cost warn.
  const notify = async (status, { digest = "", summary = "" } = {}) => {
    if (!cfg.notifyCmd) return;
    const cmdLine = cfg.notifyCmd
      .replaceAll("{status}", status)
      .replaceAll("{digest}", digest)
      .replaceAll("{summary}", summary);
    try {
      const { spawn } = await import("node:child_process");
      spawn(cmdLine, { shell: true, detached: true, stdio: "ignore" }).unref();
    } catch { /* notification is garnish, never a failure */ }
  };
  plan.estimate = estimateRun(plan.tasks, plan.digest, loadCorpus(join(swarmHome(), "runs")));
  const io = makeDefaultIo();
  io.notify = (status) => { notify(status); };
  const r = await runPlan(plan, cfg, io, { force });

  out(formatClosing({
    digestPath: r.digestPath,
    digestFailed: r.digestFailed,
    summaryPath: r.summaryPath,
    totalTokens: r.summary.totalTokens,
    worktreesKept: r.worktreesKept,
    truncations: r.summary.truncations,
    estimate: plan.estimate,
  }));

  const bad = r.summary.tasks.filter((t) => !["ok", "skipped"].includes(t.state) && t.id !== "__digest");
  await notify(
    bad.length ? `swarm run finished with ${bad.length} failed/blocked` : "swarm run finished clean",
    { digest: r.digestPath || "", summary: r.summaryPath || "" },
  );
  if (bad.length) {
    out(`FAILED tasks: ${bad.map((t) => `${t.id} [${t.state}]`).join(", ")}`);
    const quotaBad = bad.filter((t) => t.state === "quota");
    if (quotaBad.length) {
      const resets = quotaBad.map((t) => readResult(plan.resultsDir, t.id)?.quotaResetsAt).find(Boolean);
      out(`quota: ${quotaBad.length} leaf(s) blocked by Anthropic usage limits${resets ? ` — re-run after ${resets}` : ""}`);
    }
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
        const quietWarnMs = (getConfig().quietWarnSecs ?? 60) * 1000;
        if (rest.includes("--watch")) {
          const ivIdx = rest.indexOf("--interval");
          const secs = ivIdx >= 0 ? Math.max(1, Number(rest[ivIdx + 1]) || 5) : 5;
          // Repaint until Ctrl-C. Env override lets tests bound the loop.
          const maxTicks = Number(process.env.SWARM_WATCH_TICKS) || Infinity;
          for (let i = 0; i < maxTicks; i++) {
            process.stdout.write("\x1b[2J\x1b[H");
            out(renderStatus(rest[0], Date.now(), quietWarnMs));
            out(dim(`(watch: refreshing every ${secs}s — Ctrl-C to exit)`));
            await new Promise((r) => setTimeout(r, secs * 1000));
          }
          return 0;
        }
        out(renderStatus(rest[0], Date.now(), quietWarnMs));
        return 0;
      }
      case "ask": {
        const positional = [];
        let model;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--model") model = rest[++i];
          else positional.push(rest[i]);
        }
        const [resultsDir, taskId, question] = positional;
        if (!resultsDir || !taskId || !question) { err(USAGE); return 1; }
        const { askLeaf } = await import("../src/ask.mjs");
        const { formatTokens } = await import("../src/results.mjs");
        const { tokenTotal } = await import("../src/stream.mjs");
        const r = await askLeaf({ resultsDir, taskId, question, model, cfg: getConfig() });
        out(r.answer);
        out("");
        out(dim(`tokens: ${formatTokens(tokenTotal(r.tokens))} · session ${r.sessionId} · log: results/${taskId}.ask.log`));
        return 0;
      }
      case "quota": {
        const { checkQuota } = await import("../src/quota.mjs");
        const q = await checkQuota({
          cfg: getConfig(),
          fetch: (...a) => globalThis.fetch(...a),
          cachePath: join(swarmHome(), "quota-cache.json"),
          ...(process.env.SWARM_CREDENTIALS && { credentialsPath: process.env.SWARM_CREDENTIALS }),
        });
        if (!q) {
          out("quota: unavailable (no Claude Code credentials, or the usage endpoint did not respond)");
          return 0;
        }
        for (const l of q.limits) {
          const scope = l.scope ? ` (${l.scope})` : "";
          const sev = l.severity && l.severity !== "normal" ? ` [${l.severity}]` : "";
          out(`${l.kind}${scope}: ${l.percent}%${l.resetsAt ? ` — resets ${l.resetsAt}` : ""}${sev}`);
        }
        return q.exhausted ? 1 : 0;
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

// Delayed exit: undici's UV_ASYNC handle double-closes on immediate exit
// after fetch on Windows (libuv UV_HANDLE_CLOSING assertion).
const code = await main();
setTimeout(() => process.exit(code), 150);
