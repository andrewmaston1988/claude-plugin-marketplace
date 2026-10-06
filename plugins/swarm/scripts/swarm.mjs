#!/usr/bin/env node
// swarm CLI — thin argv layer over src/. Subcommands: models | validate | run.
// stdout carries status lines + paths only, never raw task output.
import { join, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, swarmHome, getConfig } from "../src/config.mjs";
import { costOfFor } from "../src/run-cost.mjs";
import { loadManifest, effectivePlanDoc, matchDenylist, isAgentless, ValidationError } from "../src/manifest.mjs";
import { resolveRef, listManifests } from "../src/registry.mjs";
import { modelRoster, refreshRoster } from "../src/roster.mjs";
import { collapseRoster, visibleModels, probeTopModels } from "../src/discovery.mjs";
import { enabledProviderIds, providerConfig } from "../src/providers.mjs";
import { costBands, costSettings } from "../src/cost-settings.mjs";
import { defaultProviderRegistry } from "../src/default-providers.mjs";
import { loadCorpus, estimateRun, formatEstimate, leafCounts, integrateCaps } from "../src/estimate.mjs";
import { citationPaths } from "../src/citations.mjs";
import { formatKeptWorktrees, listLeaves, stopPath, appendRunLog, writeSummary, resultPath } from "../src/results.mjs";
import { identityOf, identityKey } from "../src/contracts.mjs";
import { runLiveness, readRun, ALIVE_STATES } from "../src/runlog.mjs";
import { plan as planPrune, execute as executePrune, formatPrune, registeredUnder, repoOfWorktree, reposOfTrees, makeGit, reposFromManifest } from "../src/prune.mjs";
import { addTokens, emptyTokens } from "../src/stream.mjs";
import { dim, out, err } from "../src/ui.mjs";
import { markValidated } from "../src/validated.mjs";
import { cmdRun, refuseLiveEngine } from "../src/cmd-run.mjs";
import { cmdServe } from "./cmd-serve.mjs";
import { cmdStatus } from "./cmd-status.mjs";
import { cmdReport } from "./cmd-report.mjs";
import { cmdCost } from "./cmd-cost.mjs";
import { cmdGradeInit, cmdGradeFile, cmdGradeWaive } from "./cmd-grade.mjs";
import { modelLine, effortsCell } from "../src/model-row.mjs";

const USAGE = `usage: swarm.mjs <command>
  models [--all]             list launchable models from enabled providers (+ Claude aliases)
  list                       saved manifests (<cwd>/.swarm/manifests + ~/.swarm/manifests)
  validate <manifest.json | name> [--args '<json>'] [--resolved]   lint; exit 1 with readable errors
  run <manifest.json | name> [--args '<json>'] [--force]   execute the plan (use Bash run_in_background)
  status <resultsDir>        one-shot progress view of a run (reads run.log)
  status <resultsDir> --watch [--interval <secs>]   live repaint until Ctrl-C
  status --mine              this session's finished runs still holding kept worktrees, each with its prune command
  wait <resultsDir> [--timeout <secs>]  block until the run settles, then print the final roster (exit 0 clean · 1 leaf not ok · 2 engine died · 3 timed out)
  stop <resultsDir>          cooperative stop: signal a live engine and wait, or record a dead one — never kills a process
  prune <resultsDir> [--dry-run]   destroy a finished run's kept worktrees + branches; refuses a live run
  report <resultsDir>        render the run's digest.md/report.md → digest.html/report.html (self-contained, theme-aware; backfill for old runs)
  ask <resultsDir> <taskId> "<question>" [--model <m>]   resume a finished leaf's session with a follow-up
  quota | usage              provider utilization per limit window (exit 1 when Anthropic is exhausted)
  ollama-usage [--cookie '<value>']   ollama.com :cloud weekly-allowance meter (exit 1 when exhausted)
  grade --init <resultsDir>  write grades.json — one skeleton row per model leaf (Claude tiers included), for you to fill in
  grade --file <grades.json>   validate the filled batch and append it to ~/.swarm/model-scores.jsonl
  grade --waive <resultsDir> --reason "<text>"   excuse a run from grading — writes grade-waiver.json, never a store row
  perf [--aspect X] [--model Y] [--domain D] [--overall]   aspect x model table; --overall = one combined ranking
  scores backfill-realmodel [--dry-run]   rewrite alias-named score rows to the model their leaf transcript reports
  cost                       one cost list per provider, cheapest to dearest (meter + static rate cards)
  refresh-prices [--dry-run]   re-read both vendors' published price tables and bank them at ~/.swarm/rate-cards.json
  serve [--daemon]           phone dashboard over ~/.swarm/runs on the LAN (config: dashboard.enabled/port/bind/token)
  serve restart | doctor | stop | status | enable | disable | install-autostart | uninstall-autostart
  config init                write every shipped key into ~/.swarm/config.json, keeping what is set and folding an old-shaped file ("provider"/"codex") into "providers" — it prints the mapping and leaves the previous file at config.json.bak; the /swarm:swarm setup skill walks it
  statusline install         write the self-resolving statusline shim to ~/.swarm/statusline.mjs and print the settings.json line
  install                    put swarm on PATH: bash + cmd wrappers and the resolver copy in ~/.local/bin (idempotent; never edits a shell profile)`;

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

// The single ollama usage entry point for the CLI — the usage file's 5-minute
// TTL is what lets validate/run/models share one fetch however many seats.
async function usageHeadroom(cfg, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return (await import("../src/ollama-usage.mjs")).getUsage(cfg, { env, _fetch: fetchImpl });
}

// The OLLAMA METER rows, for joins against the Ollama roster and the dispatch
// frontier. Deliberately not the provider walk: `swarm perf` and the seat report
// rank on the meter's own axis and its bands, and a published-price weight from
// another provider's rate card would be a cross-provider rank — the one thing
// the units forbid. `swarm cost` asks cost.mjs for all three lists instead.
//
// The history banks the meter's own names (the page's `data-model`);
// deriveCloudName is the same mapping discovery uses — never a second rule. Both
// reads are cheap and a missing file reads as empty, so a fresh install is
// simply "unmeasured".
async function meterCostRows(env = process.env) {
  const { ollamaCloudCostRows, readSnapshots, usageHistoryPath } = await import("../src/cost.mjs");
  return ollamaCloudCostRows(readSnapshots(usageHistoryPath(env)));
}

// Read usage through registered provider capabilities. `live` lets an adapter
// fetch at all — the cache still governs whether it does; `force` is the
// operator's refresh, which only `swarm usage --provider` asks for.
export async function readProviderUsage(cfg, { registry = defaultProviderRegistry(), live = false, force = false, provider, env = process.env, fetchImpl = globalThis.fetch, quotaCheck } = {}) {
  const { getUsage } = await import("../src/ollama-usage.mjs");
  const { normalizeProviderUsage } = await import("../src/usage.mjs");
  const usages = [];
  const errors = {};
  for (const adapter of registry.list()) {
    if ((provider && adapter.id !== provider) || !adapter.enabled(cfg)) continue;
    const readUsage = registry.capability(adapter.id, "readUsage");
    if (!readUsage) continue;
    try {
      const reading = live && adapter.id === "ollama"
        ? await getUsage(cfg, { gate: false, env, _fetch: fetchImpl, force })
        : await readUsage({ config: cfg, env, fetch: fetchImpl, usageOptIn: live, force, ...(quotaCheck && { quotaCheck }) });
      if (reading == null) continue;
      usages.push(normalizeProviderUsage(adapter.id, reading));
    } catch (error) {
      errors[adapter.id] = error?.message || String(error);
    }
  }
  return { usages, errors };
}

function displayModel(value, roster = []) {
  const model = value?.model || value;
  const providers = new Set(roster.filter((row) => row?.model === model && row?.provider).map((row) => row.provider));
  return providers.size > 1 && value?.provider ? `${value.provider}/${model}` : model;
}

function visibleProviderModels(rows, options) {
  const groups = new Map();
  for (const row of rows) {
    const provider = row?.provider || "ollama";
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(row);
  }
  return [...groups.values()].flatMap((group) => visibleModels(group, options));
}

function providerEnabled(registry, cfg, value) {
  const provider = value?.provider || "ollama";
  try { return registry.get(provider).enabled(cfg); } catch { return false; }
}

async function cmdModels(rest = [], {
  cfg = getConfig(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  registry = defaultProviderRegistry(),
  write = out,
} = {}) {
  // Catalogue stays the catalogue (discovery.mjs is pure) — the meter is
  // annotated here, above the :cloud list, so it reads as a preflight rather
  // than a per-model property. The banner replaces the old stale line: a
  // reading that was not fetched now is marked, or not shown at all.
  const { provenanceBanner, formatResetTime } = await import("../src/usage.mjs");
  const headroom = await usageHeadroom(cfg, { env, fetchImpl });
  for (const line of provenanceBanner(headroom)) write(line);
  if (headroom.state === "exhausted") {
    const resets = formatResetTime(headroom.resetsAt) ?? headroom.resetsAt;
    write(`⚠ :cloud weekly allowance exhausted (${headroom.weeklyPctUsed}%) — resets ${resets}. These models will not launch.`);
  }
  const showAll = rest.includes("--all");
  const isDenylisted = (name) => !!matchDenylist(name, cfg);
  // The operator's forced refresh; a failed provider keeps its banked rows, so
  // one offline account cannot erase another provider's roster.
  const refreshed = await refreshRoster({
    config: cfg,
    env,
    registry,
    fetchImpl,
    force: true,
    rich: true,
  });
  for (const [provider, message] of Object.entries(refreshed.errors)) {
    write(`⚠ ${provider} model discovery unavailable — using cached rows (${message})`);
  }
  const read = modelRoster({ config: cfg, env, registry });
  writeRosterErrors(read.errors, write);
  const roster = read.models;
  const ollamaRows = roster.filter((m) => (m.provider || "ollama") === "ollama");
  const ollama = providerConfig(cfg, "ollama");
  const base = String(ollama.url || "").replace(/\/+$/, "");
  const ollamaEnabled = providerEnabled(registry, cfg, { provider: "ollama" });
  // Every models run re-discovers, so this is the one place the top-3
  // entitlement probe fires. A 402 evicts the row from its own provider entry.
  const liveOllama = base && ollamaEnabled
    ? await probeTopModels(ollamaRows, base, fetchImpl, { isDenylisted, provider: "ollama" })
    : ollamaRows;
  // A disabled provider is left out of the refresh, so its entry keeps its last
  // roster for a re-enable — never shown as launchable.
  // The one collapse site for every provider — without it a Codex or Claude
  // roster prints a superseded generation beside the model that replaced it,
  // and `--all` has no `supersededBy` to mark the row with.
  const liveRoster = collapseRoster([
    ...roster.filter((m) => (m.provider || "ollama") !== "ollama"),
    ...liveOllama,
  ].filter((m) => providerEnabled(registry, cfg, m) && !isDenylisted(m.model)), { cloudSuffix: ollama.cloudSuffix });
  const visible = new Set(visibleProviderModels(liveRoster, { isDenylisted }).map(identityKey));
  const shown = showAll ? liveRoster : liveRoster.filter((m) => visible.has(identityKey(m)));
  // `swarm models` is step 1 of the skill, so a fresh install meets an empty roster before
  // it ever meets a validation refusal. The footer alone is a dead end; name the way out.
  if (!shown.length) {
    write(dim("no launchable models — run /swarm:swarm setup to enable a provider and set allowedRoots"));
  }
  const { readRows, scoresPath, frontier } = await import("../src/scores.mjs");
  const costRows = await meterCostRows(env);
  const multOf = new Map(costRows.map((r) => [r.model, r.mult]));
  const onFrontier = new Set(frontier(readRows(scoresPath(env)), costRows.map((r) => ({ model: r.model, mult: r.mult })), { bands: await costBands(cfg) })
    .filter((e) => e.onFrontier).map((e) => e.model));
  for (const m of shown) {
    const mark = showAll && m.supersededBy && !visible.has(identityKey(m)) ? ` [superseded by ${m.supersededBy}]` : "";
    const mult = multOf.get(m.model);
    const cost = m.provider && m.provider !== "ollama" ? "—" : mult == null ? "—" : onFrontier.has(m.model) ? `* ${mult.toFixed(1)}x` : `${mult.toFixed(1)}x`;
    write(modelLine({ ...m, displayModel: displayModel(m, liveRoster) }) + mark + `  ${effortsCell(m, roster)}  ${cost}`);
  }
  write(dim("* on the quality/cost frontier · N.Nx = meter weight vs the cheapest measured model (swarm cost) · — unmeasured, not free"));
  const hidden = liveRoster.length - shown.length;
  if (hidden) write(dim(`${hidden} superseded hidden — swarm models --all shows them`));
  return 0;
}

// Distinct seated models in manifest order, each with its leaf ids — the walk
// leafCounts uses (agentless skipped, childPlan descended), ids instead of
// counts. A forEach lane names its template id: the per-item instances do not
// exist yet at validate time.
function seatedModels(plan) {
  const byModel = new Map();
  const add = (value, leaf) => {
    const identity = identityOf(value);
    if (!identity.model) return;
    const key = identityKey(identity);
    if (!byModel.has(key)) byModel.set(key, { identity, leaves: [] });
    byModel.get(key).leaves.push(leaf);
  };
  for (const t of plan.tasks) {
    if (isAgentless(t)) continue;
    if (t.childPlan) {
      for (const c of t.childPlan.tasks) {
        if (isAgentless(c)) continue;
        add(c, c.id);
      }
      continue;
    }
    add(t, t.id);
  }
  if (plan.digest?.model) add(plan.digest, "__digest");
  return [...byModel.values()].map(({ identity, leaves }) => ({
    ...(identity.provider ? { provider: identity.provider } : {}),
    model: identity.model,
    leaves,
  }));
}

// The launchable roster `swarm models` prints, from the roster the one reader
// serves — never a fresh probe: validate must not gain a network call.
async function launchableRoster(cfg, { env = process.env, registry = defaultProviderRegistry() } = {}) {
  const isDenylisted = (name) => !!matchDenylist(name, cfg);
  const cached = modelRoster({ config: cfg, env, registry }).models;
  const enabled = collapseRoster(cached.filter((m) => providerEnabled(registry, cfg, m)),
    { cloudSuffix: providerConfig(cfg, "ollama")?.cloudSuffix });
  const visible = new Set(visibleProviderModels(enabled, { isDenylisted }).map(identityKey));
  const offered = enabled.filter((m) => !isDenylisted(m.model));
  return offered.filter((m) => visible.has(identityKey(m)));
}

// The seats block: the graded record for the manifest's seats, printed so the
// seating decision is made in front of the evidence. Silent when grading is
// off or the store is empty (a user who has never graded meets nothing), and
// the store read is skipped entirely in both cases, not just the print.
async function seatBlock(plan, cfg) {
  if (cfg.grading?.enabled !== true) return [];
  const models = seatedModels(plan);
  if (!models.length) return [];
  const { readRows, scoresPath } = await import("../src/scores.mjs");
  const rows = readRows(scoresPath());
  if (!rows.length) return [];
  const { seatReport } = await import("../src/seats.mjs");
  return seatReport({
    models,
    rows,
    costRows: await meterCostRows(),
    roster: await launchableRoster(cfg),
    ...(await costSettings()),
  });
}

// The reader never throws, so a roster it could not read or hydrate says so here.
function writeRosterErrors(errors, write) {
  for (const [provider, message] of Object.entries(errors)) write(`roster: ${provider} — ${message}`);
}

async function cmdValidate(rest) {
  const cfg = getConfig();
  const args = parseArgsFlag(rest);
  const ref = resolveManifestRef(rest[0]);
  const fromRegistry = ref.source !== "path";
  const roster = modelRoster({ config: cfg, env: process.env, registry: defaultProviderRegistry() });
  writeRosterErrors(roster.errors, err);
  const plan = loadManifest(ref.path, cfg, process.cwd(), { args, fromRegistry, headroom: await usageHeadroom(cfg), cache: roster.models, ...(fromRegistry && { ref: rest[0] }) });
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
      ...integrateCaps(plan.tasks),
    ].join(", ");
    const label = composed.length ? "expansion" : "forEach expansion";
    out(`worst case: up to ${leaves} leaves${caps ? ` after ${label} (${caps})` : ""}${computes.length ? ` · ${computes.length} compute step(s), zero tokens` : ""}`);
  }
  // returns schemas are part of the approval surface: say which tasks are
  // guaranteed shape, and what the guarantee costs when output misses.
  const ret = plan.tasks.filter((t) => t.returns);
  if (ret.length) {
    out(`returns validated: ${ret.map((t) => t.id).join(", ")} (invalid output gets up to 3 corrective re-asks, then fails)`);
  }
  // N3: mechanical verification is approval-surface behavior — say which tasks
  // will have their {file,line,quote} citations checked against real files.
  const cited = ret.filter((t) => t.verifyCitations !== false && citationPaths(t.returns).length);
  if (cited.length) {
    out(`citations verified mechanically: ${cited.map((t) => t.id).join(", ")} (file/line/quote checked against the task cwd; a refuted citation gets one corrective re-ask, then is annotated — never fails the leaf)`);
  }
  // Read coverage is approval-surface too, and independent of returns: name the
  // tasks whose transcript will be checked against their mustRead declaration.
  const mustRead = plan.tasks.filter((t) => t.mustRead);
  if (mustRead.length) {
    const describe = (t) => {
      const n = t.mustRead.length;
      const index = t.mustRead.some((e) => e && typeof e === "object" && e.index !== undefined);
      return `${t.id} (${n} ${n === 1 ? "entry" : "entries"}${index ? ", index" : ""})`;
    };
    out(`must-read enforced: ${mustRead.map(describe).join(", ")} (transcript checked against mustRead; a shortfall gets one corrective re-ask, then is recorded — never fails the leaf)`);
  }
  // The consent line: worst-case leaves × historical per-model medians.
  out(formatEstimate(estimateRun(plan.tasks, plan.digest, loadCorpus(join(swarmHome(), "runs")))));
  for (const line of await seatBlock(plan, cfg)) out(line);
  out(`resultsDir: ${plan.resultsDir}`);
  // The gate-preview contract for named/parameterized runs: print the fully
  // resolved document (args substituted, children expanded) LAST, so the whole
  // tail of stdout is the JSON being approved. Every leaf's model and prompt
  // must be visible here — that is W1's acceptance invariant.
  if (rest.includes("--resolved")) {
    out("resolved manifest:");
    out(JSON.stringify(effectivePlanDoc(plan), null, 2));
  }
  return markValidated(plan, args);
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
  // Every repo the manifest named, not just the first: a run spanning two repos
  // leaves trees in both, and a dead engine is the only chance to record them.
  const git = makeGit(spawnSync);
  const worktreesKept = reposFromManifest(fs, dir)
    .filter((repo) => fs.existsSync(repo))
    .flatMap((repo) => registeredUnder(git, repo, dir).filter((r) => r.branch)
      .map((r) => ({ name: basename(r.path), branch: r.branch, path: r.path })));

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
  // A killed run wrote no summary.json; prune must tolerate that and never invent one.
  const summaryFile = join(dir, "summary.json");
  const hadSummary = fs.existsSync(summaryFile);
  const summary = hadSummary ? JSON.parse(fs.readFileSync(summaryFile, "utf8")) : null;
  const worktreesKept = Array.isArray(summary?.worktreesKept) ? summary.worktreesKept : [];
  // Resolve each tree's own repo: one scalar attributed a second repo's tree to the
  // first and `git worktree remove` then silently failed against the wrong cwd.
  const keptWithRepo = worktreesKept.map((wt) => ({ ...wt, repo: wt.repo || repoOfWorktree(spawnSync, wt.path) }));
  const repos = [...new Set([...keptWithRepo.map((wt) => wt.repo), ...reposFromManifest(fs, dir), ...reposOfTrees(fs, dir, spawnSync)].filter(Boolean))];
  if (!repos.length) {
    err(`swarm: could not resolve the repo for ${dir} — no kept worktree survives and manifest.json has no cwd.`);
    return 1;
  }
  const git = makeGit(spawnSync);

  const { rows } = planPrune({ live: false, repos, resultsDir: dir, worktreesKept: keptWithRepo }, git, fs);
  if (!rows.length) {
    out(`swarm: ${dir} has no kept worktrees — nothing to prune.`);
    return 0;
  }
  out(formatPrune(rows, { dryRun }));
  if (!dryRun) {
    executePrune(rows, git, fs);
    // survivors: whatever wasn't just removed and wasn't already gone before we started
    if (hadSummary) writeSummary(dir, { ...summary, worktreesKept: worktreesKept.filter((wt) => fs.existsSync(wt.path)) });
  }
  return 0;
}

function getFlag(name, args) {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1];
}

async function cmdPerf(rest) {
  const { readRows, hideDisabledRows, aggregate, dedupe, scoresPath, frontier, PRIOR_WEIGHT } = await import("../src/scores.mjs");
  const aspect = getFlag("aspect", rest);
  const model = getFlag("model", rest);
  const domain = getFlag("domain", rest);
  const cfg = getConfig();
  const path = scoresPath();
  const registry = defaultProviderRegistry(), rows = hideDisabledRows(readRows(path), cfg, registry, modelRoster({ config: cfg, registry }).models);
  const report = aggregate(rows, { aspect, model, domain, combineProviders: true });
  const costs = await meterCostRows();
  const settings = await costSettings(cfg);
  const { bands } = settings;
  // A model is dominated when another is at least as good on both and better
  // on one; `*` marks the frontier. Unmeasured cost renders "—": blank would
  // read as dominated when the truth is unknown.
  const costCols = (f) => ({
    cost: f && f.band != null ? "$".repeat(f.band) : "—",
    frontier: f ? (f.onFrontier ? "*" : f.dominatedBy ? `dom ${f.dominatedBy}` : "—") : "—",
  });
  const byModel = (entries) => {
    const grouped = new Map();
    for (const entry of entries) {
      const list = grouped.get(entry.model) || [];
      list.push(entry);
      grouped.set(entry.model, list);
    }
    return new Map([...grouped].map(([name, list]) => [name, list.length === 1 ? list[0] : { providerLocal: true }]));
  };
  const LEGEND = "    cost $/$$/$$$ = meter weight band vs the cheapest measured model (swarm cost) · * on the quality/cost frontier · dom <model> = a model at least as good and as cheap, better on one, exists · provider-local = multiple providers for this model · — unmeasured, not free · seat from the frontier, never by quality÷cost";
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
    const o = (await import("../src/perf-overall.mjs")).perfOverall({ cfg, roster: await launchableRoster(cfg), rows, costRows: costs, ...settings, model, domain, out });
    const costByModel = byModel(frontier(rows, costs, { model, domain, bands }));
    const w = Math.max(5, ...o.cells.map((c) => c.model.length));
    out(`    ${"model".padEnd(w)}    n  overall  ${o.universals.map((a) => a.slice(0, 5).padStart(5)).join("  ")}  cost  frontier`);
    for (const c of o.cells) {
      const cols = o.universals.map((a) => (c.wtds[a] == null ? "—" : c.wtds[a].toFixed(2)).padStart(5)).join("  ");
      const candidate = costByModel.get(c.model);
      const { cost, frontier: fm } = candidate?.providerLocal
        ? { cost: "—", frontier: "provider-local" }
        : costCols(candidate);
      const flag = (c.combined == null ? dim("  [no grades — outcomes only]") : c.provisional ? dim("  [provisional n<5]") : "")
        + (c.supersededBy ? dim(`  [superseded by ${c.supersededBy}]`) : "");
      const bad = Object.entries(c.outcomes).filter(([k, v]) => v > 0 && k !== "completed");
      const tail = bad.length ? dim(`  · ${bad.map(([k, v]) => `${k} ${v}`).join(", ")}`) : "";
      out(`    ${c.model.padEnd(w)}  ${String(c.n).padStart(3)}  ${(c.combined == null ? "—" : c.combined.toFixed(2)).padStart(7)}  ${cols}  ${cost.padEnd(4)}${fm}${flag}${tail}`);
    }
    out(dim("    overall = mean of the four universal weighted scores; capability aspects excluded"));
    out(dim(LEGEND));
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
    const costByModel = byModel(frontier(rows, costs, { aspect: a.aspect, model, domain, bands }));
    const w = Math.max(...a.cells.map((c) => c.model.length));
    for (const c of a.cells) {
      const mean = c.mean == null ? "—" : c.mean.toFixed(2);
      const wtd = c.weighted == null ? "—" : c.weighted.toFixed(2);
      const candidate = costByModel.get(c.model);
      const { cost, frontier: fm } = candidate?.providerLocal
        ? { cost: "—", frontier: "provider-local" }
        : costCols(candidate);
      const flag = c.n === 0 ? dim("  [no grades — outcomes only]") : c.provisional ? dim("  [provisional n<5]") : "";
      const bad = Object.entries(c.outcomes).filter(([k, v]) => v > 0 && k !== "completed");
      const tail = bad.length ? dim(`  · ${bad.map(([k, v]) => `${k} ${v}`).join(", ")}`) : "";
      out(`    ${c.model.padEnd(w)}  n=${String(c.n).padStart(3)}  mean ${mean.padStart(5)}  wtd ${wtd.padStart(5)}  cost ${cost.padEnd(3)}  ${fm}${flag}${tail}`);
    }
    // Both columns show, ranked on wtd: the raw mean is the evidence, the
    // weighted score is what it is worth given how much of it there is.
    if (a.prior != null) out(dim(`    prior ${a.prior.toFixed(2)} (mean of per-model means; k=${PRIOR_WEIGHT})`));
  }
  out(dim(LEGEND));
  return 0;
}

// `scores backfill-realmodel` — repair rows filed under a bare Claude alias
// (`opus`, `sonnet`, `haiku`) by reading the concrete model each leaf's OWN
// transcript reports. Those rows predate the rule that stopped them being
// written; until they are rewritten, overall()/frontier() rank the alias as a
// rival model. A row whose transcript names no model is dropped, never guessed.
// --dry-run prints the mapping and touches nothing at all.
async function cmdScoresRealmodel(rest) {
  const dryRun = rest.includes("--dry-run");
  const { readFileSync, writeFileSync, copyFileSync, existsSync } = await import("node:fs");
  const { scoresPath } = await import("../src/scores.mjs");
  const { backfillRealmodel } = await import("../src/scores-backfill.mjs");
  const { transcriptPath } = await import("../src/results.mjs");

  const path = scoresPath();
  if (!existsSync(path)) {
    err(`swarm: no score store at ${path} — nothing to backfill.`);
    return 1;
  }
  const before = readFileSync(path, "utf8");
  const plan = backfillRealmodel(before, {
    // Unreadable is null, not "": a row that cannot be read must never look like
    // a row that was read and named nothing.
    readTranscript: (resultsDir, leaf) => {
      try { return readFileSync(transcriptPath(resultsDir, leaf), "utf8"); } catch { return null; }
    },
  });

  for (const { alias, model, n } of plan.mapping) out(`${alias} -> ${model} (${n})`);
  for (const d of plan.dropped) out(`dropped: ${d.alias} ${d.leaf} @ ${d.resultsDir} — ${d.reason}`);
  out(`${plan.changed} row(s) resolved, ${plan.dropped.length} dropped${dryRun ? " — dry run, nothing written" : ""}`);
  if (dryRun) return 0;

  // Nothing resolved and nothing to drop is a no-op: re-running must not mint a
  // backup of an unchanged store.
  if (!plan.changed && !plan.dropped.length) {
    out("nothing to backfill — no alias-named rows in the store.");
    return 0;
  }
  const bak = `${path}.bak-${Date.now()}`;
  copyFileSync(path, bak);
  writeFileSync(path, plan.text);
  out(`backup: ${bak}`);
  out(`rewrote ${path}`);
  return 0;
}

async function cmdUsage(rest = [], {
  cfg = getConfig(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  registry = defaultProviderRegistry(),
  quotaCheck,
  write = out,
} = {}) {
  const { usageLines, notableLines } = await import("../src/usage.mjs");
  // `claude` is the registry id for the reading this command prints as
  // `anthropic`, so either name selects it.
  const selected = getFlag("provider", rest);
  const provider = selected === "anthropic" ? "claude" : selected;
  // The refresh command: `--provider` ignores the cache's age.
  const providerReading = await readProviderUsage(cfg, { registry, env, fetchImpl, live: true, force: true, quotaCheck, ...(provider ? { provider } : {}) });
  const usages = providerReading.usages;
  for (const [provider, message] of Object.entries(providerReading.errors)) write(`${provider}: unavailable (${message})`);
  for (const line of usageLines(usages)) write(line);
  for (const line of notableLines(usages)) write(line);
  return usages.some((u) => u.provider === "anthropic" && u.state === "exhausted" && u.provenance !== "stale") ? 1 : 0;
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
        return await cmdValidate(rest);
      }
      case "run": {
        if (!rest[0]) { err(USAGE); return 1; }
        return await cmdRun(rest, { parseArgsFlag, resolveManifestRef, usageHeadroom });
      }
      case "stop": {
        if (!rest[0]) { err(USAGE); return 1; }
        return await cmdStop(rest);
      }
      case "prune": {
        return await cmdPrune(rest);
      }
      case "serve":
        return await cmdServe(rest, { readProviderUsage });
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
        // refreshInterval (seconds): without it the harness repaints only on conversation
        // updates, so an idle session's bar freezes on its dispatch-time counts.
        out(JSON.stringify({ statusLine: { type: "command", command: cmd, refreshInterval: 5 } }, null, 2));
        return 0;
      }
      case "install": {
        // Self-resolving PATH command, mirroring ~/.local/bin/pipeline: a stable
        // resolver copy beside the wrappers means a plugin sha bump never strands
        // `swarm`. Idempotent — re-running overwrites, never appends.
        const { mkdirSync, copyFileSync, writeFileSync, chmodSync, existsSync } = await import("node:fs");
        const { homedir } = await import("node:os");
        const { installPlan } = await import("../src/cli-shim.mjs");
        const userBin = join(homedir(), ".local", "bin");
        const plan = installPlan({
          userBin,
          nodePath: process.execPath,
          resolverSrc: fileURLToPath(new URL("../statusline/resolver.mjs", import.meta.url)),
        });
        mkdirSync(userBin, { recursive: true });
        for (const e of plan) {
          const existed = existsSync(e.path);
          if (e.copyFrom) copyFileSync(e.copyFrom, e.path);
          else writeFileSync(e.path, e.content, { mode: e.mode });
          if (e.mode) chmodSync(e.path, e.mode); // writeFileSync applies mode on create only
          out(`install: ${existed ? "refreshed" : "wrote"} ${e.path}`);
        }
        out("install: `swarm` now resolves the active plugin install on every run, so plugin updates never break it. Requires ~/.local/bin on PATH (this command never edits a shell profile).");
        return 0;
      }
      case "config": {
        if (rest[0] !== "init") { err(USAGE); return 1; }
        const { initConfig, configInitReport } = await import("../src/config.mjs");
        for (const line of configInitReport(initConfig(process.env.SWARM_CONFIG))) out(line);
        return 0;
      }
      case "status": {
        if (!rest[0] && !rest.includes("--mine")) { err(USAGE); return 1; }
        return await cmdStatus(rest);
      }
      case "wait": {
        if (!rest[0]) { err(USAGE); return 1; }
        const { runWaitCommand } = await import("../src/wait.mjs");
        return await runWaitCommand(rest[0], { quietWarnSecs: getConfig().quietWarnSecs, timeoutSecs: Number(getFlag("timeout", rest)) || null, out, err });
      }
      case "report": {
        if (!rest[0]) { err(USAGE); return 1; }
        return await cmdReport(rest);
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
        const cfg = getConfig();
        // The heartbeat read, kept alongside the claim `askLeaf` takes: an engine started
        // before the lock existed — a plugin update mid-run — holds no lock, and only its
        // heartbeat says it is there. Refused here, so no run dir is touched on the way.
        if (refuseLiveEngine(resultsDir, cfg, "asking")) return 1;
        const { askLeaf } = await import("../src/ask.mjs");
        const { formatTokens } = await import("../src/results.mjs");
        const { workTokens } = await import("../src/stream.mjs");
        const r = await askLeaf({ resultsDir, taskId, question, model, cfg });
        if (!r.ok) { err(`swarm: ask failed: ${r.answer}`); return 1; }
        out(r.answer);
        out("");
        out(dim([workTokens(r.tokens) > 0 && `tokens: ${formatTokens(workTokens(r.tokens))}`, costOfFor(cfg)([r]), r.tokens?.cacheRead && `cache read ${formatTokens(r.tokens.cacheRead)}`, `session ${r.sessionId}`, `log: results/${taskId}.ask.log`].filter(Boolean).join(" · ")));
        return 0;
      }
      case "grade": {
        const initDir = getFlag("init", rest);
        const file = getFlag("file", rest);
        const waiveDir = getFlag("waive", rest);
        if (initDir) return await cmdGradeInit(initDir);
        if (file) return await cmdGradeFile(file);
        if (waiveDir) return await cmdGradeWaive(waiveDir, getFlag("reason", rest));
        err(USAGE);
        return 1;
      }
      case "perf":
        return await cmdPerf(rest);
      case "scores": {
        if (rest[0] !== "backfill-realmodel") { err(USAGE); return 1; }
        return await cmdScoresRealmodel(rest.slice(1));
      }
      case "cost":
        return await cmdCost();
      case "refresh-prices": {
        const { refreshPrices } = await import("../src/rate-card-cli.mjs");
        const { modelsByProvider } = await import("../src/cost.mjs");
        // The same roster `swarm cost` prices for, banked with the read: without
        // it a manual refresh leaves the next cost query re-fetching both pages.
        const cfg = getConfig(), registry = defaultProviderRegistry(), roster = modelRoster({ config: cfg, registry }).models;
        return await refreshPrices({
          out, err, dryRun: rest.includes("--dry-run"), rosterIds: modelsByProvider(roster), enabled: enabledProviderIds(cfg, registry),
        });
      }
      case "usage":
        return await cmdUsage(rest);
      case "quota": {
        const { printQuota } = await import("../src/quota.mjs");
        return await printQuota({
          cfg: getConfig(),
          out,
          cachePath: join(swarmHome(), "quota-cache.json"),
          credentialsPath: process.env.SWARM_CREDENTIALS,
        });
      }
      case "ollama-usage": {
        const { saveCookie, loadCookie, getUsage, ollamaCloudConfig } = await import("../src/ollama-usage.mjs");
        const cfg = getConfig();
        const cookiePath = ollamaCloudConfig(cfg).cookiePath || join(swarmHome(), "ollama-cookie.json");
        const cookieFlag = getFlag("cookie", rest);
        if (cookieFlag !== undefined) saveCookie(cookiePath, cookieFlag);

        // This subcommand's job is the FETCH and the cookie; the printing is
        // usage.mjs's, same as `quota`'s, so the two can never word a reading
        // differently. getUsage carries the provenance; gate: false because
        // fetching is this subcommand's job even before ollama is enabled.
        const { normalizeOllama, usageLines, notableLines, provenanceBanner } = await import("../src/usage.mjs");
        const reading = await getUsage(cfg, { gate: false });
        const usage = normalizeOllama(reading);
        for (const line of provenanceBanner(usage)) out(line);
        for (const line of usageLines([usage])) out(line);
        for (const line of notableLines([usage])) out(line);
        // Exit 1 means an exhausted reading, and only a LIVE one — unreadable
        // is not exhausted; a cached 100% may describe a window that reset.
        return reading.provenance === "live" && usage.state === "exhausted" ? 1 : 0;
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

export { main, cmdModels, cmdUsage, launchableRoster };

// Delayed exit: undici's UV_ASYNC handle double-closes on immediate exit
// after fetch on Windows (libuv UV_HANDLE_CLOSING assertion). Keeping the
// guard makes the CLI importable by the provider fixture and surface tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main();
  setTimeout(() => process.exit(code), 150);
}
