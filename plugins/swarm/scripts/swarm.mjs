#!/usr/bin/env node
// swarm CLI — thin argv layer over src/. Subcommands: models | validate | run.
// stdout carries status lines + paths only, never raw task output.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, swarmHome } from "../src/config.mjs";
import { loadManifest, effectivePlanDoc, matchDenylist, ValidationError } from "../src/manifest.mjs";
import { resolveRef, listManifests } from "../src/registry.mjs";
import { discoverModels, writeModelsCache, visibleModels, probeTopModels } from "../src/discovery.mjs";
import { runPlan, makeDefaultIo } from "../src/scheduler.mjs";
import { loadCorpus, estimateRun, formatEstimate, leafCounts } from "../src/estimate.mjs";
import { citationPaths } from "../src/citations.mjs";
import { formatClosing, renderStatus, readResult, listLeaves } from "../src/results.mjs";
import { dim } from "../src/ui.mjs";

const USAGE = `usage: swarm.mjs <command>
  models [--all]             list launchable :cloud models (+ Claude aliases)
  list                       saved manifests (<cwd>/.swarm/manifests + ~/.swarm/manifests)
  validate <manifest.json | name> [--args '<json>'] [--resolved]   lint; exit 1 with readable errors
  run <manifest.json | name> [--args '<json>'] [--force]   execute the plan (use Bash run_in_background)
  status <resultsDir>        one-shot progress view of a run (reads run.log)
  status <resultsDir> --watch [--interval <secs>]   live repaint until Ctrl-C
  report <resultsDir>        render report.md → report.html (self-contained, theme-aware)
  ask <resultsDir> <taskId> "<question>" [--model <m>]   resume a finished leaf's session with a follow-up
  quota                      Anthropic subscription utilization per limit window (exit 1 when exhausted)
  grade --init <resultsDir>  write grades.json — one skeleton row per model leaf (Claude tiers included), for you to fill in
  grade --file <grades.json>   validate the filled batch and append it to ~/.swarm/model-scores.jsonl
  perf [--aspect X] [--model Y] [--domain D]   aspect x model table with sample counts`;

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
    gradeable: {
      count: listLeaves(plan.resultsDir, { gradeable: true }).length,
      resultsDir: plan.resultsDir,
      cli: fileURLToPath(import.meta.url),
    },
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
      domain: "<lowercase ecosystem — e.g. godot, rust, images, this-repo>",
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
  const { readRows, aggregate, dedupe, scoresPath, PRIOR_WEIGHT } = await import("../src/scores.mjs");
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
