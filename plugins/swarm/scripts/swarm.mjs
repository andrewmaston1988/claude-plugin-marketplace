#!/usr/bin/env node
// swarm CLI — thin argv layer over src/. Subcommands: models | validate | run.
// stdout carries status lines + paths only, never raw task output.
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, swarmHome } from "../src/config.mjs";
import { loadManifest, effectivePlanDoc, matchDenylist, ValidationError } from "../src/manifest.mjs";
import { resolveRef, listManifests } from "../src/registry.mjs";
import { discoverModels, writeModelsCache, visibleModels, probeTopModels } from "../src/discovery.mjs";
import { runPlan, makeDefaultIo } from "../src/scheduler.mjs";
import { loadCorpus, estimateRun, formatEstimate, leafCounts } from "../src/estimate.mjs";
import { citationPaths } from "../src/citations.mjs";
import { formatClosing, formatKeptWorktrees, renderStatus, readResult, listLeaves, stopPath, appendRunLog, writeSummary, resultPath } from "../src/results.mjs";
import { runLiveness, readRun, ALIVE_STATES } from "../src/runlog.mjs";
import { plan as planPrune, execute as executePrune, formatPrune, registeredUnder } from "../src/prune.mjs";
import { addTokens, emptyTokens } from "../src/stream.mjs";
import { dim } from "../src/ui.mjs";

const USAGE = `usage: swarm.mjs <command>
  models [--all]             list launchable :cloud models (+ Claude aliases)
  list                       saved manifests (<cwd>/.swarm/manifests + ~/.swarm/manifests)
  validate <manifest.json | name> [--args '<json>'] [--resolved]   lint; exit 1 with readable errors
  run <manifest.json | name> [--args '<json>'] [--force]   execute the plan (use Bash run_in_background)
  status <resultsDir>        one-shot progress view of a run (reads run.log)
  status <resultsDir> --watch [--interval <secs>]   live repaint until Ctrl-C
  stop <resultsDir>          cooperative stop: signal a live engine and wait, or record a dead one — never kills a process
  prune <resultsDir> [--dry-run]   destroy a finished run's kept worktrees + branches; refuses a live run
  report <resultsDir>        render report.md → report.html (self-contained, theme-aware)
  ask <resultsDir> <taskId> "<question>" [--model <m>]   resume a finished leaf's session with a follow-up
  quota                      Anthropic subscription utilization per limit window (exit 1 when exhausted)
  ollama-usage [--cookie '<value>']   ollama.com :cloud weekly-allowance meter (exit 1 when exhausted)
  grade --init <resultsDir>  write grades.json — one skeleton row per model leaf (Claude tiers included), for you to fill in
  grade --file <grades.json>   validate the filled batch and append it to ~/.swarm/model-scores.jsonl
  perf [--aspect X] [--model Y] [--domain D] [--overall]   aspect x model table; --overall = one combined ranking
  serve [--daemon]           phone dashboard over ~/.swarm/runs on the LAN (config: dashboard.enabled/port/bind/token)
  serve restart | doctor | stop | status | install-autostart | uninstall-autostart
  config init                write every shipped key into ~/.swarm/config.json (keeps what is set) — the /swarm:swarm setup skill walks it
  statusline install         write the self-resolving statusline shim to ~/.swarm/statusline.mjs and print the settings.json line`;

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

// --args '<json>' → object, or a teaching error. Anything that isn't a JSON
// object (bad JSON, array, scalar) fails the same way.
function parseArgsFlag(rest) {
  const i = rest.indexOf("--args");
  if (i < 0) return undefined;
  let v;
  try {
    v = JSON.parse(rest[i + 1]);
  } catch {
    v = undefined;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new ValidationError([`--args must be a JSON object — e.g. --args '{"base":"master"}' (got ${JSON.stringify(rest[i + 1])})`]);
  }
  return v;
}

// Resolve a manifest ref (path or registry name) and announce a registry hit —
// the name is a lookup, never a hiding place, so the resolution is always shown.
function resolveManifestRef(ref) {
  const r = resolveRef(ref, process.cwd(), process.env);
  if (r.source !== "path") out(`resolved: ${ref} → ${r.path} (${r.source})`);
  return r;
}

function fmtParams(n) {
  return n >= 1e12 ? `${(n / 1e12).toFixed(1)}T` : `${Math.round(n / 1e9)}B`;
}

function fmtCtx(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M ctx` : `${Math.round(n / 1e3)}k ctx`;
}

function modelLine(m) {
  const line = m.description ? `${m.model} — ${m.description}` : m.model;
  if (!(m.parameterCount > 0) && !(m.contextLength > 0)) return line;
  const size = m.parameterCount > 0 ? fmtParams(m.parameterCount) : "size unreported";
  return `${line} (${[size, ...(m.contextLength > 0 ? [fmtCtx(m.contextLength)] : [])].join(", ")})`;
}

async function cmdModels(rest = []) {
  const cfg = getConfig();
  // Catalogue stays the catalogue (discovery.mjs is pure) — the meter is
  // annotated here, above the :cloud list, so it reads as a preflight rather
  // than a per-model property.
  const { usageFromCache } = await import("../src/ollama-usage.mjs");
  const headroom = usageFromCache(cfg);
  if (headroom.state === "exhausted") {
    out(`⚠ :cloud weekly allowance exhausted (${headroom.weeklyPctUsed}%) — resets ${headroom.resetsAt}. These models will not launch.`);
  } else if (headroom.state === "stale") {
    out(`⚠ :cloud weekly allowance meter is stale (last read ${Math.floor(headroom.snapshotAgeMs / 3_600_000)}h ago) — run \`swarm ollama-usage\` to refresh.`);
  }
  const showAll = rest.includes("--all");
  const isDenylisted = (name) => !!matchDenylist(name, cfg);
  const discovered = await discoverModels(cfg);
  // Cache keeps the FULL roster — denylist and supersession filter at print,
  // and the entitlement probe/scheduler removal need rows present to remove.
  writeModelsCache(discovered);
  const base = String(cfg.provider.url).replace(/\/+$/, "");
  // Every models run re-discovers, so this is the one place the top-3
  // entitlement probe fires. 402 removals rewrite the cache just written.
  const live = await probeTopModels(discovered, base, globalThis.fetch, { isDenylisted });
  const visible = new Set(visibleModels(live, { isDenylisted }).map((m) => m.model));
  const offered = live.filter((m) => !isDenylisted(m.model));
  const shown = showAll ? offered : offered.filter((m) => visible.has(m.model));
  for (const m of [...shown, ...CLAUDE_ALIASES.filter((a) => !isDenylisted(a.model))]) {
    const mark = showAll && m.supersededBy && !visible.has(m.model) ? ` [superseded by ${m.supersededBy}]` : "";
    out(modelLine(m) + mark);
  }
  const hidden = offered.length - shown.length;
  if (hidden) out(dim(`${hidden} superseded hidden — swarm models --all shows them`));
  return 0;
}

function cmdValidate(rest) {
  const cfg = getConfig();
  const args = parseArgsFlag(rest);
  const ref = resolveManifestRef(rest[0]);
  const fromRegistry = ref.source !== "path";
  const plan = loadManifest(ref.path, cfg, process.cwd(), { args, fromRegistry, ...(fromRegistry && { ref: rest[0] }) });
  out(`manifest OK: ${plan.tasks.length} task(s)${plan.digest ? " + digest" : ""}`);
  // The preview IS the approval: with forEach or composition in play, show the
  // worst-case leaf count the caps permit before anything runs.
  const fans = plan.tasks.filter((t) => t.forEach && !t.childPlan);
  const computes = plan.tasks.filter((t) => t.compute);
  const composed = plan.tasks.filter((t) => t.childPlan);
  if (fans.length || computes.length || composed.length) {
    const leaves = [...leafCounts(plan.tasks, undefined).values()].reduce((a, b) => a + b, 0);
    const caps = [
      ...fans.map((t) => `${t.id} ≤ ${t.forEach.maxItems}`),
      ...composed.map((t) => {
        const n = t.childPlan.tasks.filter((c) => c.compute === undefined).length;
        return t.forEach ? `${t.id} ≤ ${t.forEach.maxItems} × ${n} child leaves` : `${t.id} = ${n} child leaves`;
      }),
    ].join(", ");
    const label = composed.length ? "expansion" : "forEach expansion";
    out(`worst case: up to ${leaves} leaves${caps ? ` after ${label} (${caps})` : ""}${computes.length ? ` · ${computes.length} compute step(s), zero tokens` : ""}`);
  }
  // returns schemas are part of the approval surface: say which tasks are
  // guaranteed shape, and what the guarantee costs when output misses.
  const ret = plan.tasks.filter((t) => t.returns);
  if (ret.length) {
    out(`returns validated: ${ret.map((t) => t.id).join(", ")} (invalid output gets one corrective re-ask, then fails)`);
  }
  // N3: mechanical verification is approval-surface behavior — say which tasks
  // will have their {file,line,quote} citations checked against real files.
  const cited = ret.filter((t) => t.verifyCitations !== false && citationPaths(t.returns).length);
  if (cited.length) {
    out(`citations verified mechanically: ${cited.map((t) => t.id).join(", ")} (file/line/quote checked against the task cwd; refuted citations get one corrective re-ask, then fail)`);
  }
  // The consent line: worst-case leaves × historical per-model medians.
  out(formatEstimate(estimateRun(plan.tasks, plan.digest, loadCorpus(join(swarmHome(), "runs")))));
  out(`resultsDir: ${plan.resultsDir}`);
  // The gate-preview contract for named/parameterized runs: print the fully
  // resolved document (args substituted, children expanded) LAST, so the whole
  // tail of stdout is the JSON being approved. Every leaf's model and prompt
  // must be visible here — that is W1's acceptance invariant.
  if (rest.includes("--resolved")) {
    out("resolved manifest:");
    out(JSON.stringify(effectivePlanDoc(plan), null, 2));
  }
  return 0;
}

async function cmdRun(rest) {
  const cfg = getConfig();
  const force = rest.includes("--force");
  const args = parseArgsFlag(rest);
  const ref = resolveManifestRef(rest[0]);
  const fromRegistry = ref.source !== "path";
  const plan = loadManifest(ref.path, cfg, process.cwd(), { args, fromRegistry, ...(fromRegistry && { ref: rest[0] }) });
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

  // Ground truth, up front: a session that has to reconstruct the run directory
  // gets it wrong (the default is <stem>-1, and --force reuses it rather than
  // minting <stem>-2). Print the path and the exact watch command so the string
  // handed to the operator is copied, never remembered.
  out(`resultsDir: ${plan.resultsDir}`);
  out(`watch:      node ${fileURLToPath(import.meta.url)} status ${plan.resultsDir} --watch`);

  const io = makeDefaultIo();
  io.notify = (status) => { notify(status); };
  const r = await runPlan(plan, cfg, io, { force });

  // A cache replay IS a success: the results are valid and the resume workflow
  // depends on it, so the exit code stays 0 and the caching is untouched. What must
  // change is the WORDING — "finished clean" plus a bare digest path let a session
  // skim the tail and report a no-op as a completed fresh round. The digest it
  // points at predates this invocation; say so.
  const live = r.summary.tasks.filter((t) => t.id !== "__digest");
  const replayed = live.length > 0 && live.every((t) => t.state === "skipped");
  if (replayed) {
    out(`NOTHING RE-EXECUTED — all ${live.length} task(s) replayed from cache in ${plan.resultsDir}.`);
    out("The digest below is from the PREVIOUS run, not this invocation — nothing about it is new.");
    out("To re-execute this manifest: --force (same resultsDir; results are overwritten).");
  }

  out(formatClosing({
    digestPath: r.digestPath,
    reportPath: r.reportPath,
    reportMissing: r.reportMissing,
    digestFailed: r.digestFailed,
    summaryPath: r.summaryPath,
    totalTokens: r.summary.totalTokens,
    worktreesKept: r.worktreesKept,
    truncations: r.summary.truncations,
    refutations: r.summary.refutations,
    estimate: plan.estimate,
    resultsDir: plan.resultsDir,
    engine: fileURLToPath(import.meta.url),
    // Grading is opt-in (grading.enabled): off, the closing block never asks and
    // the skill's grade step is skipped; `grade`/`perf` still work when called.
    gradeable: cfg.grading?.enabled === true ? {
      count: listLeaves(plan.resultsDir, { gradeable: true }).length,
      resultsDir: plan.resultsDir,
      cli: fileURLToPath(import.meta.url),
    } : undefined,
  }));

  const bad = r.summary.tasks.filter((t) => !["ok", "skipped"].includes(t.state) && t.id !== "__digest");
  await notify(
    bad.length ? `swarm run finished with ${bad.length} failed/blocked`
      : replayed ? "swarm run finished — cache replay, nothing re-executed"
        : "swarm run finished clean",
    { digest: r.digestPath || "", ...(r.reportPath && { report: r.reportPath }), summary: r.summaryPath || "" },
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
  if (r.summary.stopped) return 1;
  return 0;
}

// A worktree-registry read behind an injected git — the closure production
// code and tests both build over the raw spawnSync.
function makeGit(spawnSync) {
  return (args, cwd) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60000 });
    return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
  };
}

// Once every kept worktree is gone there is nothing left to ask for the repo —
// manifest.json's cwd (the invoking process's cwd at dispatch) is the only
// surviving record of it.
function repoFromManifest(fs, dir) {
  try {
    const m = JSON.parse(fs.readFileSync(join(dir, "manifest.json"), "utf8"));
    return typeof m.cwd === "string" ? m.cwd : null;
  } catch {
    return null;
  }
}

// Dead engine: no live process to signal, so nothing is killed. The run-stop
// event + summary are the only record — read straight from disk (readRun),
// mirroring the shape runPlan itself writes so every reader treats the two
// the same way.
async function recordDeadEngineStop(dir) {
  appendRunLog(dir, { ts: new Date().toISOString(), event: "run-stop", reason: "dead-engine" });
  const run = readRun(dir);
  const tasks = run.tasks.map((t) => ({
    id: t.id,
    model: t.model,
    state: ALIVE_STATES.has(t.state) ? "failed:stopped" : t.state,
    durationMs: t.durationMs ?? null,
    tokens: t.tokens ?? null,
    resultPath: resultPath(dir, t.id),
  }));

  const fs = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const repo = repoFromManifest(fs, dir);
  const worktreesKept = repo && fs.existsSync(repo)
    ? registeredUnder(makeGit(spawnSync), repo, dir).map((r) => ({ name: basename(r.path), branch: r.branch, path: r.path }))
    : [];

  const summary = {
    started: run.startedMs ? new Date(run.startedMs).toISOString() : new Date().toISOString(),
    finished: new Date().toISOString(),
    stopped: true,
    stopReason: "dead-engine",
    tasks,
    blocked: run.tasks.filter((t) => t.state === "blocked").map((t) => t.id),
    worktreesKept,
    totalTokens: tasks.reduce((acc, t) => addTokens(acc, t.tokens || emptyTokens()), emptyTokens()),
  };
  writeSummary(dir, summary);
  const stopped = tasks.filter((t) => t.state === "failed:stopped").map((t) => t.id);
  out(`swarm: ${dir} — engine appears dead (stale heartbeat, no summary). Recorded run-stop; no process touched.`);
  out(`marked failed:stopped: ${stopped.length ? stopped.join(", ") : "(none — every leaf had already settled)"}`);
  if (worktreesKept.length) {
    out(formatKeptWorktrees(worktreesKept, { resultsDir: dir, engine: fileURLToPath(import.meta.url) }));
  }
  return 0;
}

async function cmdStop(rest) {
  const dir = resolve(rest[0]);
  const cfg = getConfig();
  const heartbeatMs = Math.max(50, (cfg.heartbeatSecs ?? 15) * 1000);
  const live = runLiveness(dir, { heartbeatMs });
  if (live.finishedMs != null) { err(`swarm: ${dir} already finished — nothing to stop.`); return 1; }
  if (live.stoppedMs != null) { err(`swarm: ${dir} already stopped — nothing to stop.`); return 1; }
  if (live.abortedMs != null) return await recordDeadEngineStop(dir);

  const { writeFileSync } = await import("node:fs");
  writeFileSync(stopPath(dir), "");
  const pollMs = heartbeatMs / 2;
  const deadline = Date.now() + heartbeatMs * 2;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const l = runLiveness(dir, { heartbeatMs });
    if (l.finishedMs != null || l.stoppedMs != null) {
      out(`swarm: ${dir} stopped.`);
      return 0;
    }
  }
  err(`swarm: engine did not respond within ${Math.round((heartbeatMs * 2) / 1000)}s — if it is wedged, end its process and run stop again to record it.`);
  return 1;
}

// A worktree's own `.git` file names its repo's common dir — no need for the
// run record to carry `repo` at all, so long as at least one kept tree is
// still on disk to ask.
function repoOfWorktree(spawnSync, worktreePath) {
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: worktreePath, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  return dirname(resolve(worktreePath, (r.stdout || "").trim()));
}

async function cmdPrune(rest) {
  // The dir is the first non-flag arg, so `prune --dry-run <dir>` and
  // `prune <dir> --dry-run` mean the same thing.
  const target = rest.find((a) => !a.startsWith("--"));
  if (!target) { err(USAGE); return 1; }
  const dir = resolve(target);
  const dryRun = rest.includes("--dry-run");
  const fs = await import("node:fs");
  // runLiveness reads "no run.log, no summary, no heartbeat" as a live run with
  // nothing written yet — for prune that is a typo'd path, not something to refuse.
  if (!fs.existsSync(join(dir, "run.log"))) { err(`swarm: no run at ${dir} (no run.log)`); return 1; }
  const cfg = getConfig();
  const heartbeatMs = Math.max(50, (cfg.heartbeatSecs ?? 15) * 1000);
  const live = runLiveness(dir, { heartbeatMs });
  if (live.finishedMs == null && live.stoppedMs == null && live.abortedMs == null) {
    err(`swarm: ${dir} live — swarm stop it first`);
    return 1;
  }

  const { spawnSync } = await import("node:child_process");
  const summary = JSON.parse(fs.readFileSync(join(dir, "summary.json"), "utf8"));
  const worktreesKept = Array.isArray(summary.worktreesKept) ? summary.worktreesKept : [];

  const repo = worktreesKept.map((wt) => repoOfWorktree(spawnSync, wt.path)).find(Boolean)
    || repoFromManifest(fs, dir);
  if (!repo) {
    err(`swarm: could not resolve the repo for ${dir} — no kept worktree survives and manifest.json has no cwd.`);
    return 1;
  }
  const git = makeGit(spawnSync);

  const { rows } = planPrune({ live: false, repo, resultsDir: dir, worktreesKept }, git, fs);
  if (!rows.length) {
    out(`swarm: ${dir} has no kept worktrees — nothing to prune.`);
    return 0;
  }
  out(formatPrune(rows, { dryRun }));
  if (!dryRun) executePrune(rows, git, fs);
  return 0;
}

function getFlag(name, args) {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1];
}

// `grade --init` — one skeleton row per model leaf, every grade null. It is
// deliberately unappendable as written: validation rejects a null universal, so
// an untouched skeleton cannot land.
async function cmdGradeInit(dir) {
  const { writeFileSync } = await import("node:fs");
  const { UNIVERSAL, CAPABILITY, OUTCOMES } = await import("../src/aspects.mjs");
  const leaves = listLeaves(dir, { gradeable: true });
  if (!leaves.length) {
    err(`swarm: no gradeable leaves with results in ${dir} — agentless nodes carry no model, so there is nothing to grade.`);
    return 1;
  }
  const skeleton = {
    resultsDir: dir,
    session: "<this session's id>",
    rows: leaves.map((l) => ({
      leaf: l.id,
      model: l.model,
      read: { result: l.resultPath, transcript: l.transcriptPath },
      domain: "<one lowercase token: the language or ecosystem the leaf worked in — rust, godot, node, python, docs. Not the repo, not the task>",
      outcome: `<${OUTCOMES.join(" | ")}>`,
      note: "",
      grades: {
        ...Object.fromEntries(UNIVERSAL.map((a) => [a, null])),
        ...Object.fromEntries(CAPABILITY.map((a) => [a, null])),
      },
    })),
  };
  const p = join(dir, "grades.json");
  writeFileSync(p, JSON.stringify(skeleton, null, 2) + "\n");
  out(p);
  out(`${leaves.length} gradeable leaf/leaves. Grade the four universal aspects 1-10 on every row; leave a`);
  out("capability aspect null unless the leaf stressed it. Drop `grades` entirely on a row whose leaf");
  out("produced no output (failed / timeout / session-died / not-capable), then:");
  out(`  swarm grade --file ${p}`);
  return 0;
}

// `grade --file` — the batch carries only judgement. model, mechanical and
// declared are resolved from disk here, so they cannot be fabricated.
async function cmdGradeFile(path) {
  const { readFileSync, existsSync } = await import("node:fs");
  const { readResult, mechanicalOf } = await import("../src/results.mjs");
  const { appendRows, scoresPath } = await import("../src/scores.mjs");
  if (!existsSync(path)) { err(`swarm: no grades file at ${path}`); return 1; }
  let batch;
  try {
    batch = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    err(`swarm: ${path} is not valid JSON: ${e.message}`);
    return 1;
  }
  const dir = batch?.resultsDir;
  const session = batch?.session;
  if (typeof dir !== "string" || !dir.trim() || !Array.isArray(batch.rows) || !batch.rows.length) {
    err('swarm: grades file must be { "resultsDir": "<run dir>", "session": "<id>", "rows": [ … ] }');
    return 1;
  }
  if (typeof session !== "string" || !session.trim() || session.startsWith("<")) {
    err('swarm: fill in "session" with this session\'s id — every row records who graded it.');
    return 1;
  }

  const cacheEntries = await readModelsCache();
  const date = new Date().toISOString().slice(0, 10);
  const ts = new Date().toISOString();
  const manifestTasks = await readManifestTasks(dir);
  const rows = [];
  // Collect every missing leaf before failing, matching validateRow's batch-wide
  // error collection — one round-trip should surface all of them, not the first.
  const missing = batch.rows.filter((r) => !readResult(dir, r?.leaf)).map((r) => r?.leaf);
  if (missing.length) {
    err(`swarm: no results/<id>.json in ${dir} for: ${missing.join(", ")} — the mechanical block cannot be fabricated, so nothing was written.`);
    return 1;
  }
  for (const r of batch.rows) {
    const result = readResult(dir, r.leaf);
    const declared = cacheEntries.get(result.model);
    const { isClaudeModel } = await import("../src/models.mjs");
    if (!declared && !isClaudeModel(result.model)) err(dim(`warning: ${result.model} is not in models-cache.json — declared capabilities recorded as null (run \`swarm models\` to refresh)`));
    rows.push({
      ts,
      resultsDir: dir,
      leaf: r.leaf,
      model: result.model,
      effort: manifestTasks.get(r.leaf)?.effort ?? null,
      domain: r.domain,
      ...(r.grades !== undefined && { grades: r.grades }),
      outcome: r.outcome,
      note: r.note ?? "",
      assessedBy: { session, date },
      mechanical: mechanicalOf(result),
      declared: declared ?? null,
    });
  }
  try {
    appendRows(rows, scoresPath());
  } catch (e) {
    err(`swarm: ${e.message}`);
    return 1;
  }
  out(`${rows.length} row(s) appended to ${scoresPath()}`);
  return 0;
}

async function readModelsCache() {
  const map = new Map();
  try {
    const { readFileSync } = await import("node:fs");
    const cache = JSON.parse(readFileSync(join(swarmHome(), "models-cache.json"), "utf8"));
    for (const m of cache?.models || []) {
      map.set(m.model, {
        capabilities: m.capabilities ?? null,
        contextLength: m.contextLength ?? null,
        parameterCount: m.parameterCount ?? null,
      });
    }
  } catch { /* no cache — declared stays null and the caller warns */ }
  return map;
}

// Effort is a manifest field, not a result field; the snapshot at dispatch is
// where a run records its own intent.
async function readManifestTasks(dir) {
  const map = new Map();
  try {
    const { readFileSync } = await import("node:fs");
    const doc = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    for (const t of doc?.tasks || []) map.set(t.id, t);
  } catch { /* a run without a snapshot simply records no effort */ }
  return map;
}

async function cmdPerf(rest) {
  const { readRows, aggregate, overall, dedupe, scoresPath, PRIOR_WEIGHT } = await import("../src/scores.mjs");
  const aspect = getFlag("aspect", rest);
  const model = getFlag("model", rest);
  const domain = getFlag("domain", rest);
  const path = scoresPath();
  const rows = readRows(path);
  const report = aggregate(rows, { aspect, model, domain });
  const filters = Object.entries(report.filters).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" · ");
  // Lines and rows differ after a re-grade: the store is append-only and the
  // newest row per (resultsDir, leaf) wins, so say both rather than let the raw
  // line count read as coverage.
  const live = dedupe(rows).length;
  const counted = live === rows.length ? `${live} row(s)` : `${live} row(s) (${rows.length} lines, re-grades superseded)`;
  out(`model scores: ${counted} · ${path}`);
  if (filters) out(`filters: ${filters}`);
  out("");
  if (rest.includes("--overall")) {
    // One table: models ranked on the mean of the four universal weighted
    // scores; per-aspect columns beside it so the average cannot hide a hole.
    const o = overall(rows, { model, domain });
    const w = Math.max(5, ...o.cells.map((c) => c.model.length));
    out(`    ${"model".padEnd(w)}    n  overall  ${o.universals.map((a) => a.slice(0, 5).padStart(5)).join("  ")}`);
    for (const c of o.cells) {
      const cols = o.universals.map((a) => (c.wtds[a] == null ? "—" : c.wtds[a].toFixed(2)).padStart(5)).join("  ");
      const flag = c.combined == null ? dim("  [no grades — outcomes only]") : c.provisional ? dim("  [provisional n<5]") : "";
      const bad = Object.entries(c.outcomes).filter(([k, v]) => v > 0 && k !== "completed");
      const tail = bad.length ? dim(`  · ${bad.map(([k, v]) => `${k} ${v}`).join(", ")}`) : "";
      out(`    ${c.model.padEnd(w)}  ${String(c.n).padStart(3)}  ${(c.combined == null ? "—" : c.combined.toFixed(2)).padStart(7)}  ${cols}${flag}${tail}`);
    }
    out(dim("    overall = mean of the four universal weighted scores; capability aspects excluded"));
    return 0;
  }
  for (const a of report.aspects) {
    out(`${a.aspect}${a.universal ? dim("  (universal)") : ""}`);
    if (!a.cells.length) {
      // Absence is evidence: an aspect nothing has been graded on is a finding,
      // never a row to hide.
      out(dim("    n=0 — no rows"));
      continue;
    }
    const w = Math.max(...a.cells.map((c) => c.model.length));
    for (const c of a.cells) {
      const mean = c.mean == null ? "—" : c.mean.toFixed(2);
      const wtd = c.weighted == null ? "—" : c.weighted.toFixed(2);
      const flag = c.n === 0 ? dim("  [no grades — outcomes only]") : c.provisional ? dim("  [provisional n<5]") : "";
      const bad = Object.entries(c.outcomes).filter(([k, v]) => v > 0 && k !== "completed");
      const tail = bad.length ? dim(`  · ${bad.map(([k, v]) => `${k} ${v}`).join(", ")}`) : "";
      out(`    ${c.model.padEnd(w)}  n=${String(c.n).padStart(3)}  mean ${mean.padStart(5)}  wtd ${wtd.padStart(5)}${flag}${tail}`);
    }
    // Both columns show, ranked on wtd: the raw mean is the evidence, the
    // weighted score is what it is worth given how much of it there is.
    if (a.prior != null) out(dim(`    prior ${a.prior.toFixed(2)} (mean of per-model means; k=${PRIOR_WEIGHT})`));
  }
  return 0;
}

// serve — the LAN dashboard. Foreground by default; --daemon forks a detached
// copy and records its pid (written by the parent, per the plugin daemon rule).
async function cmdServe(rest) {
  const { writePid, readPid, clearPid, isAlive, urlLines, firewallHint, installAutostart, uninstallAutostart, defaultStartupDir, pidPath,
    resolveInstalled, isStale, blocksStart, bindFailureRecordAction, waitForDaemon, statusReport, doctorChecks, doctorExit, registryPath, ensureShim, probePort, waitForExit, restartPlan, drainAndClose } = await import("../src/serve/daemon.mjs");
  const home = swarmHome();
  const cfg = getConfig();
  const port = cfg.dashboard?.port ?? 7331;
  const enginePath = fileURLToPath(import.meta.url);
  const verb = rest[0] && !rest[0].startsWith("--") ? rest[0] : "start";
  const exitSoon = (code) => { setTimeout(() => process.exit(code), 150); };
  const installed = resolveInstalled({ registry: registryPath() });
  // The stable shim every restart/re-exec goes through — never this file, which
  // sits in the sha-versioned plugin cache and moves on every update.
  const shimPath = join(home, "serve.mjs");

  if (verb === "stop") {
    const rec = readPid(home);
    const pid = rec?.pid;
    if (!pid || !isAlive(pid)) { out("dashboard: not running"); clearPid(home); exitSoon(0); return 0; }
    try { process.kill(pid); } catch (e) { err(`dashboard: could not stop pid ${pid}: ${e.message}`); exitSoon(1); return 1; }
    clearPid(home);
    out(`dashboard: stopped pid ${pid}`);
    exitSoon(0); return 0;
  }
  if (verb === "status") {
    const rec = readPid(home);
    const alive = isAlive(rec?.pid);
    const rep = statusReport({ record: rec, alive, installed, port, urls: alive ? urlLines(port) : [], startupDir: defaultStartupDir(), shimPath });
    for (const line of rep.lines) out(line);
    exitSoon(rep.exit); return rep.exit;
  }
  if (verb === "doctor") {
    const rec = readPid(home);
    const alive = isAlive(rec?.pid);
    const checks = await doctorChecks({ record: rec, alive, installed, port, bind: cfg.dashboard?.bind ?? "0.0.0.0", startupDir: defaultStartupDir(), shimPath });
    for (const c of checks) out(`${c.status === "pass" ? "✓" : c.status === "unknown" ? "⚠" : "✗"} ${c.name}: ${c.detail}`);
    const code = doctorExit(checks);
    if (code) out(`${checks.filter((c) => c.status === "fail").length} check(s) failed`);
    else out("all checks passed");
    exitSoon(code); return code;
  }
  if (verb === "install-autostart" || verb === "uninstall-autostart") {
    const startupDir = defaultStartupDir();
    // Point the launcher at the resolver shim on a stable path, never at this
    // file: enginePath is inside the sha-versioned plugin cache and moves on
    // every update.
    const shim = ensureShim({ home, resolverSrc: fileURLToPath(new URL("../statusline/resolver.mjs", import.meta.url)) });
    const r = verb === "install-autostart"
      ? installAutostart({ startupDir, nodePath: process.execPath, enginePath: shim, engineArgs: ["scripts/swarm.mjs", "serve", "--daemon"] })
      : uninstallAutostart({ startupDir });
    if (!startupDir) out(`no Startup folder on this platform — add "${process.execPath}" "${shim}" scripts/swarm.mjs serve --daemon to your login items by hand`);
    else out(verb === "install-autostart" ? `autostart: ${r.changed ? "installed" : "already installed"} → ${r.path}` : `autostart: ${r.removed ? "removed" : "was not installed"}`);
    exitSoon(0); return 0;
  }
  if (verb !== "start" && verb !== "restart") { err(USAGE); return 1; }

  // The off switch — covers restart too, which would stop the daemon and start
  // nothing. stop/status/doctor/autostart verbs still work above, so a Startup
  // launcher left installed becomes a no-op instead of needing uninstalling.
  if (cfg.dashboard?.enabled === false) { out("dashboard: disabled (dashboard.enabled=false in ~/.swarm/config.json)"); exitSoon(0); return 0; }

  // The --daemon parent records the child's pid before the child gets here, so a
  // pid equal to our own is us, not a rival. A live daemon with a moved-off
  // version does NOT block start — starting is then a takeover of it.
  const running = readPid(home);
  const aliveRunning = isAlive(running?.pid);
  const takeover = Boolean(running?.pid && running.pid !== process.pid && aliveRunning && isStale(running, installed));
  if (blocksStart(running, installed, process.pid, aliveRunning)) {
    out(`dashboard: already running (pid ${running.pid})`);
    for (const u of urlLines(port)) out(`  ${u}`);
    exitSoon(0); return 0;
  }
  if (takeover) out(`dashboard: taking over from stale pid ${running.pid} (running ${running.version} → installed ${installed?.version})`);

  // The detached spawn shared by --daemon and restart. On a takeover the parent
  // must NOT write the pid record: the live old daemon still owns it, and the
  // child hands it back if it loses the bind. In the normal case the parent
  // writes pre-fork so a second `serve --daemon` sees the child and short-circuits.
  const startDetached = async () => {
    ensureShim({ home, resolverSrc: fileURLToPath(new URL("../statusline/resolver.mjs", import.meta.url)) });
    const { spawn } = await import("node:child_process");
    const { openSync, mkdirSync, writeFileSync, renameSync } = await import("node:fs");
    mkdirSync(home, { recursive: true });
    // Raw stdio (crash stacks) — separate from dashboard.log, which the daemon
    // itself owns as a structured, rotated event log.
    const logPath = join(home, "dashboard-stdio.log");
    const logFd = openSync(logPath, "a");
    let child;
    try { child = spawn(process.execPath, [enginePath, "serve"], { detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true }); }
    catch (e) { return { ok: false, reason: `could not spawn the daemon: ${e.message}` }; }
    child.unref();
    if (!takeover) writePid(home, { pid: child.pid, port, installPath: installed?.installPath ?? null, version: installed?.version ?? null, startedMs: Date.now() });
    if (process.platform === "win32" && cfg.dashboard?.tray !== false) {
      try {
        const { renderTrayIconPng } = await import("../src/serve/icon.mjs");
        const iconPath = join(home, "dashboard-icon.png");
        writeFileSync(`${iconPath}.tmp`, renderTrayIconPng());
        renameSync(`${iconPath}.tmp`, iconPath);
        const trayScript = fileURLToPath(new URL("../src/serve/tray.ps1", import.meta.url));
        // The tray needs a console — powershell.exe is a console-subsystem exe whose
        // WinForms message loop dies without one, and `detached: true` strips it
        // (DETACHED_PROCESS) — and it must outlive this short-lived parent: `cmd /c
        // start` gives it a fresh hidden console AND breaks it out of our job. Same
        // shape as slack-bridge claude-slack.mjs:245-270; its Task-Scheduler reason
        // does not apply here (swarm autostarts from the Startup folder), but the
        // console and breakaway halves both do.
        const tray = spawn("cmd.exe", ["/c", "start", "", "/min", "powershell.exe", "-WindowStyle", "Hidden", "-NonInteractive",
          "-File", trayScript, "-PidFile", pidPath(home), "-NodeExe", process.execPath, "-ShimPath", shimPath,
          "-Port", String(port), "-IconPath", iconPath, "-Home", home], { detached: true, stdio: "ignore", windowsHide: true });
        tray.unref();
      } catch (e) { err(`dashboard: tray not started: ${e.message}`); }
    }
    return { ok: true, pid: child.pid, logPath };
  };

  if (verb === "restart") {
    const rec = readPid(home);
    const pid = rec?.pid;
    const wasAlive = Boolean(pid && isAlive(pid));
    // Wait for the signalled daemon to ACTUALLY exit before starting anything.
    // Starting while it still holds the port loses the bind, and clearing its
    // record while it is alive leaves a daemon `serve stop` can never reach.
    let exited = true;
    if (wasAlive) {
      try { process.kill(pid); } catch (e) { err(`dashboard: could not stop pid ${pid}: ${e.message}`); exitSoon(1); return 1; }
      ({ exited } = await waitForExit(pid, { isAlive }));
    }
    const plan = restartPlan({ record: rec, wasAlive, exited });
    if (plan.act === "abort") {
      err(`dashboard: restart aborted — ${plan.reason} (pid ${pid}); nothing was stopped or started`);
      exitSoon(1); return 1;
    }
    if (wasAlive) out(`dashboard: stopped pid ${pid}`);
    else out("dashboard: not running — starting");
    if (plan.clearRecord) clearPid(home);
    const started = await startDetached();
    if (!started.ok) { err(`dashboard: ${started.reason}`); exitSoon(1); return 1; }
    const w = await waitForDaemon({ read: () => readPid(home), isAlive, excludePid: pid ?? null, deadlineMs: 15000 });
    if (!w.ok) { err(`dashboard: restart failed — ${w.reason}`); exitSoon(1); return 1; }
    out(`dashboard: restarted pid ${w.record.pid} (version ${w.record.version ?? "unknown"})`);
    for (const u of urlLines(port)) out(`  ${u}`);
    exitSoon(0); return 0;
  }

  if (rest.includes("--daemon")) {
    const started = await startDetached();
    if (!started.ok) { err(`dashboard: ${started.reason}`); exitSoon(1); return 1; }
    out(`dashboard: started pid ${started.pid} (events: ${join(home, "dashboard.log")}, stdio: ${started.logPath})`);
    for (const u of urlLines(port)) out(`  ${u}`);
    out(dim(`firewall (once, elevated): ${firewallHint(port)}`));
    exitSoon(0); return 0;
  }

  const { createServer } = await import("../src/serve/server.mjs");
  const { createLogger } = await import("../src/serve/log.mjs");
  const { startUpdateWatch } = await import("../src/serve/update-watch.mjs");
  ensureShim({ home, resolverSrc: fileURLToPath(new URL("../statusline/resolver.mjs", import.meta.url)) });
  const dlog = createLogger({ logDir: home }).log;
  const server = createServer({ home, cfg, log: (m) => err(`dashboard: ${m}`) });
  const bind = cfg.dashboard?.bind ?? "0.0.0.0";
  // SSE streams never "finish", so they cannot count as in-flight for the
  // handover drain — they are ended outright at handover and the browser
  // reconnects to the replacement. Tracked from before the first listen so a
  // handover never misses a stream.
  const sockets = new Set();
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  const sse = new Set();
  server.on("request", (req, res) => {
    if ((req.headers.accept || "").includes("text/event-stream")) {
      sse.add(res);
      res.on("close", () => sse.delete(res));
    }
  });
  const listenOnce = () => new Promise((resolve, reject) => {
    const onErr = (e) => reject(e);
    server.once("error", onErr);
    server.listen(port, bind, () => { server.removeListener("error", onErr); resolve(); });
  });
  const record = { pid: process.pid, port, installPath: installed?.installPath ?? null, version: installed?.version ?? null, startedMs: Date.now() };
  const prevRecord = readPid(home); // a live stale daemon we are taking over from, if any
  writePid(home, record); // before listen, per the daemon lifecycle rule; handed back below if listen fails
  try {
    await listenOnce();
  } catch (e) {
    // A failed bind must not strand a live rival recordless — `serve stop` could
    // then never reach it. Hand the record back; clear only what was ours.
    const act = bindFailureRecordAction({ current: readPid(home), prevRecord, ownPid: process.pid, alive: isAlive });
    if (act.act === "restore") writePid(home, act.record);
    else if (act.act === "clear") clearPid(home);
    throw e;
  }
  writePid(home, { ...record, listening: true }); // the restart/handover protocol reads this
  out(`dashboard: serving ~/.swarm/runs on port ${port}`);
  for (const u of urlLines(port)) out(`  ${u}`);
  out(dim(`firewall (once, elevated): ${firewallHint(port)}`));

  // Handover plumbing for the update watcher: release the port for the
  // replacement, retake it when the replacement fails. Plain requests drain
  // first; anything still holding the port after the grace window is cut.
  const exitDaemon = (code) => { setTimeout(() => process.exit(code), 150); };
  const prepare = async () => {
    for (const res of sse) { try { res.end(); } catch {} }
    sse.clear();
    await drainAndClose({
      close: (cb) => server.close(cb),
      destroySockets: () => { for (const s of sockets) { try { s.destroy(); } catch {} } },
    });
  };
  const retake = async () => {
    try {
      await listenOnce();
    } catch (e) {
      // Someone else holds the port. A live daemon on the record, or anything
      // reachable there, is the dashboard being served — bow out. Only a dead
      // port we cannot retake is a wedge, and a record still naming us must
      // not linger pointing at a pid that gave up.
      const cur = readPid(home);
      if (cur?.pid && cur.pid !== process.pid && isAlive(cur.pid)) { exitDaemon(0); return; }
      const p = await probePort(port, bind);
      if (p.reachable) { exitDaemon(0); return; }
      if (cur?.pid === process.pid) clearPid(home);
      exitDaemon(1);
      return;
    }
    writePid(home, { ...record, listening: true });
  };
  dlog("serve", { msg: `listening on ${bind}:${port}`, pid: record.pid, version: record.version });
  startUpdateWatch({
    registryPath: registryPath(), own: record, shimPath, home,
    autoRestart: cfg.dashboard?.autoRestartOnUpdate !== false,
    prepare, retake,
    log: (msg) => dlog("update-watch", { msg }),
  });
  const stop = () => { const cur = readPid(home); if (cur?.pid === process.pid) clearPid(home); server.close(); setTimeout(() => process.exit(0), 150); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {}); // serve until signalled
  return 0;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "models":
        return await cmdModels(rest);
      case "list": {
        const entries = listManifests(process.cwd(), process.env);
        if (!entries.length) {
          out("no saved manifests — save one as <cwd>/.swarm/manifests/<name>.json or ~/.swarm/manifests/<name>.json");
          return 0;
        }
        for (const e of entries) {
          out(`${e.collision ? "⚠ collision: " : ""}${e.name}  (${e.scope})  ${e.goal ? `${e.goal} — ` : ""}${e.path}`);
        }
        return 0;
      }
      case "validate": {
        if (!rest[0]) { err(USAGE); return 1; }
        return cmdValidate(rest);
      }
      case "run": {
        if (!rest[0]) { err(USAGE); return 1; }
        return await cmdRun(rest);
      }
      case "stop": {
        if (!rest[0]) { err(USAGE); return 1; }
        return await cmdStop(rest);
      }
      case "prune": {
        return await cmdPrune(rest);
      }
      case "serve":
        return await cmdServe(rest);
      case "statusline": {
        if (rest[0] !== "install") { err(USAGE); return 1; }
        const { copyFileSync, mkdirSync } = await import("node:fs");
        const home = swarmHome();
        mkdirSync(home, { recursive: true });
        const shim = join(home, "statusline.mjs");
        copyFileSync(fileURLToPath(new URL("../statusline/resolver.mjs", import.meta.url)), shim);
        const cmd = `node ${shim.replaceAll("\\", "/")}`;
        out(`statusline: shim written to ${shim} — it resolves the installed plugin on every paint, so plugin updates never break it.`);
        out("Add to ~/.claude/settings.json (edit the file in place; a symlinked settings.json must not be replaced):");
        out(JSON.stringify({ statusLine: { type: "command", command: cmd } }, null, 2));
        return 0;
      }
      case "config": {
        if (rest[0] !== "init") { err(USAGE); return 1; }
        const { initConfig } = await import("../src/config.mjs");
        const r = initConfig(process.env.SWARM_CONFIG);
        out(`config: ${r.path} (${r.created ? "created" : r.added.length ? `added ${r.added.length} key${r.added.length === 1 ? "" : "s"}: ${r.added.join(", ")}` : "up to date"})`);
        return 0;
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
      case "report": {
        if (!rest[0]) { err(USAGE); return 1; }
        const { readFileSync, writeFileSync, existsSync, renameSync } = await import("node:fs");
        const mdPath = join(rest[0], "report.md");
        if (!existsSync(mdPath)) {
          err(`swarm: no report.md in ${rest[0]} — report mode was not enabled for this run, or it has not finished.`);
          return 1;
        }
        const { mdToHtml } = await import("../src/md_to_html.mjs");
        const html = mdToHtml(readFileSync(mdPath, "utf8"));
        const htmlPath = join(rest[0], "report.html");
        const tmp = htmlPath + ".tmp";
        writeFileSync(tmp, html);
        renameSync(tmp, htmlPath);
        out(htmlPath);
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
      case "grade": {
        const initDir = getFlag("init", rest);
        const file = getFlag("file", rest);
        if (initDir) return await cmdGradeInit(initDir);
        if (file) return await cmdGradeFile(file);
        err(USAGE);
        return 1;
      }
      case "perf":
        return await cmdPerf(rest);
      case "quota": {
        // Anthropic is fetched (its credential renews itself); every cloud
        // provider is read from cache, because its cookie needs a human and
        // `quota` must not stall on one. Both print through usageLines, so the
        // subcommand and the standing-mode hook can never word this differently.
        const { checkQuota } = await import("../src/quota.mjs");
        const { normalizeAnthropic, normalizeOllama, usageLines, notableLines } = await import("../src/usage.mjs");
        const cfg = getConfig();
        const q = await checkQuota({
          cfg,
          fetch: (...a) => globalThis.fetch(...a),
          cachePath: join(swarmHome(), "quota-cache.json"),
          ...(process.env.SWARM_CREDENTIALS && { credentialsPath: process.env.SWARM_CREDENTIALS }),
        });
        const usages = [];
        if (q) usages.push(normalizeAnthropic(q));
        else out("anthropic: unavailable (no Claude Code credentials, or the usage endpoint did not respond)");

        if (cfg?.provider?.cloud?.ollama?.enabled === true) {
          const { usageFromCache } = await import("../src/ollama-usage.mjs");
          const reading = usageFromCache(cfg);
          if (reading.state === "unknown") out("ollama: no reading yet — run `swarm ollama-usage --cookie '<value>'`");
          else usages.push(normalizeOllama(reading));
        }

        for (const line of usageLines(usages)) out(line);
        // Anthropic severity is its own vocabulary and has no cross-provider
        // equivalent, so it stays an Anthropic-only annotation.
        for (const l of q?.limits || []) {
          if (l.severity && l.severity !== "normal") out(`anthropic ${l.kind}: [${l.severity}]`);
        }
        for (const line of notableLines(usages)) out(line);
        // Exit code keeps its documented meaning: Anthropic exhausted. A cloud
        // provider's state is reported, never conflated with it.
        return q?.exhausted ? 1 : 0;
      }
      case "ollama-usage": {
        const { fetchUsage, saveCookie, loadCookie, usageCachePath } = await import("../src/ollama-usage.mjs");
        const cfg = getConfig();
        const cachePath = usageCachePath();
        const cookiePath = cfg?.provider?.cloud?.ollama?.cookiePath || join(swarmHome(), "ollama-cookie.json");
        const cookieFlag = getFlag("cookie", rest);
        if (cookieFlag !== undefined) saveCookie(cookiePath, cookieFlag);
        const fetched = await fetchUsage({ cookie: loadCookie(cookiePath), cachePath });

        // This subcommand's job is the FETCH and the cookie; the printing is
        // usage.mjs's, same as `quota`'s, so the two can never word a reading
        // differently.
        const { normalizeOllama, usageLines, notableLines } = await import("../src/usage.mjs");
        const { readUsage } = await import("../src/ollama-usage.mjs");
        const { readFileSync } = await import("node:fs");
        // A successful fetch has just written the cache, so classify BOTH paths
        // by reading it back: one classifier, so a fresh 100% and a cached 100%
        // can never disagree about being exhausted.
        let reading;
        try {
          reading = readUsage(readFileSync(cachePath, "utf8"), { staleMs: cfg?.provider?.usageStaleMs });
        } catch {
          reading = { state: "unknown" };
        }
        if (reading.state === "unknown") {
          out(`ollama: no reading yet${fetched.ok ? "" : ` (${fetched.reason})`} — run with --cookie '<value>' first`);
          return 0;
        }
        const usage = normalizeOllama(reading);
        for (const line of usageLines([usage])) out(line);
        for (const line of notableLines([usage])) out(line);
        return usage.state === "exhausted" ? 1 : 0;
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
