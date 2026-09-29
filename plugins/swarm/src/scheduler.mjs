import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import {
  buildDigestTask, DIGEST_ID,
  reportPath as digestReportPath,
} from "./digest.mjs";
import { effectivePlanDoc, resolveWorktreeName, isAgentless } from "./manifest.mjs";
import {
  initResultsDir, resultPath, readResult, writeSummary, readSummary,
  writeManifestSnapshot, writeDigestMd, appendRunLog,
  renderProvenance, stopPath, recordedSessionRecords,
} from "./results.mjs";
import { formatEstimate } from "./estimate.mjs";
import { cacheHit } from "./task-key.mjs";
import { addTokens, emptyTokens } from "./stream.mjs";
import { defaultProviderRegistry } from "./default-providers.mjs";
import { createDispatchRegistry } from "./dispatch.mjs";
import { ALIVE_STATES } from "./runlog.mjs";
import { settleInline } from "./inline-steps.mjs";
import * as defaultWorktree from "./worktree.mjs";
import { makeDefaultIo } from "./scheduler/run-task.mjs";
import { createRunIdentity } from "./scheduler/run-identity.mjs";
import { createWorktreeGroups } from "./scheduler/worktree-groups.mjs";
import { createLivePaint } from "./scheduler/live-paint.mjs";
import { createHeartbeatTick } from "./scheduler/heartbeat-tick.mjs";
import { createDeterministicSteps } from "./scheduler/deterministic-steps.mjs";
import { createLaunch } from "./scheduler/launch.mjs";

export { makeDefaultIo };
export { classifyFailure, pickNewestRunning, runTask, substituteItems, substituteTemplates } from "./scheduler/run-task.mjs";

// Execute the plan's dependency graph under the concurrency cap.
// Returns { summary, summaryPath, digestPath, digestFailed, worktreesKept }.
export async function runPlan(plan, cfg, io = makeDefaultIo(), {
  force = false,
  ask = null,
  _writeSummary = writeSummary,
  providerRegistry: suppliedProviderRegistry,
  runnerRegistry,
  providerUsage,
} = {}) {
  const worktree = io.worktree || defaultWorktree;
  const tasks = [...plan.tasks];
  if (plan.digest) tasks.push(buildDigestTask(plan));
  const providerRegistry = suppliedProviderRegistry || defaultProviderRegistry();
  const effectiveRunnerRegistry = runnerRegistry || createDispatchRegistry({ providerRegistry }).runnerRegistry;
  const runtime = { providerRegistry, runnerRegistry: effectiveRunnerRegistry, resultsDir: plan.resultsDir };

  // The one object holding every local the closure groups share. Each group is
  // a createX(ctx) factory in src/scheduler/, created in the order below; a
  // later group reaches an earlier one's function through here.
  const ctx = {
    plan, cfg, io, runtime, worktree, tasks, force, ask,
    providerRegistry,
    // normalizeTasks derives worktreeName, but runPlan also accepts hand-built
    // plans — resolveWorktreeName covers both rather than silently skipping isolation.
    nameOf: resolveWorktreeName,
    children: new Map(),        // id -> live child process, for requestStop to kill
    running: new Map(),         // id -> promise resolving to task id
    state: new Map(tasks.map((t) => [t.id, "pending"])),
    durations: new Map(),
    tokensMap: new Map(),
    costMap: new Map(),         // id -> costUsd, real-key leaves only (feeds the corpus)
    turnsMap: new Map(),        // id -> requests the leaf made: a :cloud leaf's weekly-quota share
    startedAt: new Map(),
    activityMap: new Map(),     // id -> latest tool-call description
    lastEventAt: new Map(),     // id -> ms of last stream event (liveness)
    lastActivityLogAt: new Map(),
    attempts: new Map(),        // id -> retries consumed on the current model
    usedFallback: new Set(),    // ids already switched to their fallbackModel
    worktreesKept: [],
    // Memory survivability (D3/D4): ids parked because free memory is under
    // minFreeMemMb (spawn floor, or a valve kill's landing state); ids the valve
    // has just killed, read once by launch() to classify that settle as a park
    // rather than a failure. memoryParkCount is the closing block's leaf count.
    memoryParked: new Set(),
    memoryStopped: new Set(),
    memoryParkCount: 0,
    // Declared above the try: the closing summary reads them after it.
    truncations: [],
    // Citation refutations that Stage 1 kept — surfaced loud in the closing block,
    // the same register as a truncation: coverage the reader must not mistake for full.
    refutations: [],
    // Coverage shortfalls kept (D9), surfaced in the same loud closing channel.
    coverageGaps: [],
    // Groups of a shared worktree: name -> [task ids, in manifest order].
    groupMembers: new Map(),
    groupFinal: new Map(),
    groupFirst: new Map(),
    wake: () => {},             // resolves the loop's idle wait when a retry re-arms
    stopRequested: false,
    stopReason: null,
    retryWaiting: 0,            // leaves sleeping out a backoff
    retryTimers: new Set(),     // their timer handles; the finally clears any still parked
    // Single-shot projection warn: spend so far vs worst-case remaining leaves.
    completedLeaves: 0,
    spentTokens: 0,
    spentUsd: 0,
    costIsRealComplete: true,   // every completed leaf so far: real-key-billed costUsd
    costWarnFired: false,
    digestPath: null,
    digestFailed: false,
  };

  initResultsDir(plan.resultsDir);
  // A prior `swarm stop` leaves its marker and no other engine is live here (cmdRun
  // refuses one): clear it before any await, so a stop landing during startup still counts.
  rmSync(stopPath(plan.resultsDir), { force: true });
  // P1: the run records its own intent — the effective plan persists beside
  // the outcomes it produced, so the corpus can answer "what was asked".
  writeManifestSnapshot(plan.resultsDir, effectivePlanDoc(plan));

  Object.assign(ctx, createRunIdentity(ctx));
  runtime.identity = ctx.durableIdentity;
  Object.assign(ctx, createWorktreeGroups(ctx));
  Object.assign(ctx, createLivePaint(ctx));
  Object.assign(ctx, createDeterministicSteps(ctx));
  Object.assign(ctx, createLaunch(ctx));

  // Health check, once per run, only when any open-model task exists: any
  // response from the provider endpoint counts as up; fail the run fast with
  // a clear message when it is unreachable.
  // Preflights must see composed leaves too — a manifest node's children are
  // known statically even though they splice in at run time.
  const leafView = tasks.flatMap((t) => (t.childPlan ? t.childPlan.tasks : [t]));
  const providerGroups = new Map();
  // Both preflights can throw to abort the run before dispatch — caught here
  // just to remove the signal handlers first; the leaked-listener bug (a later
  // test's process.emit("SIGINT") firing this run's stale handler) is worse
  // than the throw itself, since it corrupts unrelated tests.
  try {
    for (const task of leafView) {
      if (isAgentless(task) || task.model === "manifest") continue;
      const identity = providerRegistry.resolve(task, {
        cache: cfg.modelCache || cfg.models || [],
        config: cfg,
      });
      if (!providerGroups.has(identity.provider)) providerGroups.set(identity.provider, []);
      providerGroups.get(identity.provider).push({ ...task, ...identity });
    }

    for (const [providerId, providerTasks] of providerGroups) {
      const adapter = providerRegistry.get(providerId);
      const context = {
        provider: providerId,
        tasks: providerTasks,
        config: cfg,
        io,
        fetch: io.fetch,
        now: io.now,
        env: io.env || process.env,
        ...(io.codexClient && { client: io.codexClient }),
        usageOptIn: providerUsage === true,
      };
      const preflight = providerRegistry.capability(providerId, "preflight");
      if (preflight) {
        const health = await preflight(context);
        if (health === false || health?.ok === false || health?.available === false) {
          const reason = typeof health === "object" && health.error ? ` (${health.error})` : "";
          throw new Error(`provider '${providerId}' preflight failed${reason} — tasks cannot dispatch`);
        }
      }

      if (providerUsage !== false) {
        const readUsage = providerRegistry.capability(providerId, "readUsage");
        if (readUsage) {
          const usage = await readUsage(context);
          if (usage?.exhausted && providerTasks.some((t) => !t.fallbackModel)) {
            throw new Error(`provider '${providerId}' usage is exhausted — ${providerTasks.filter((t) => !t.fallbackModel).map((t) => t.id).join(", ")} cannot dispatch`);
          }
        }
      }
    }

  } catch (e) {
    process.off("SIGINT", ctx.sigintHandler);
    process.off("SIGTERM", ctx.sigtermHandler);
    throw e;
  }

  // The approval-surface estimate (computed by the CLI) echoes at run start so
  // the consent line and the closing actual sit in the same transcript.
  if (plan.estimate !== undefined) io.stdout(formatEstimate(plan.estimate));

  ctx.started = new Date().toISOString();
  // Read before this run's run-start is appended: every session a previous engine
  // saw start, including leaves it died before settling.
  ctx.recordedSessions = force ? new Map() : recordedSessionRecords(plan.resultsDir);
  // run-start line lets `status` derive pending tasks (ids never seen since
  // the latest run-start are pending) and carries models for the roster view.
  // pid: lets a reader tell a killed engine (no summary, pid gone) from a live one.
  // launcher: the dispatching session's CLAUDE_CODE_SESSION_ID — absent when the
  // engine runs outside a session, so the run belongs to nobody rather than to
  // whoever asks about it next. A resume appends a fresh run-start, re-stamping.
  appendRunLog(plan.resultsDir, {
    ts: ctx.started, event: "run-start", pid: process.pid,
    ...(process.env.CLAUDE_CODE_SESSION_ID ? { launcher: process.env.CLAUDE_CODE_SESSION_ID } : {}),
    ...(ask && { ask: ask.taskId }),
    tasks: tasks.map((t) => ({ id: t.id, model: t.model, ...ctx.durableIdentity(t) })),
  });
  ctx.runStartMs = io.now();

  // Resume: an existing ok result satisfies the task without re-running it — its
  // recorded duration and tokens still count. Only when the task key recorded
  // with it matches today's task (task-key.mjs): the run dir is named after the
  // manifest FILE, so `prior.ok` alone replayed an edited prompt's old output,
  // and let a verifier keep a verdict about findings that no longer existed.
  // For a dependent the inputs ARE its deps' outputs, so a re-executing upstream
  // invalidates it whatever its own last run looked like — transitively, since
  // in A → B → C a re-running A invalidates C, which never names A.
  let cachedIds = new Set();
  if (ask) {
    // Every task but the one being interrogated is frozen out of scheduling —
    // an ask must reach its target with no dependent or digest re-running, and
    // no re-run of the target itself. Re-recorded as its TRUE prior state (from
    // the finished run's summary.json), not a blanket "skipped": readRunLog
    // rebuilds per-task state from scratch on every run-start line, so replaying
    // anything else here is what `status` would show for these tasks post-ask.
    const priorSummary = readSummary(plan.resultsDir, { normalize: false });
    for (const t of tasks) {
      if (t.id === ask.taskId) continue;
      const priorRow = priorSummary?.tasks?.find((r) => r.id === t.id);
      ctx.record(t, priorRow?.state ?? "skipped", priorRow?.durationMs ?? null, priorRow?.tokens ?? null);
    }
  } else if (!force) {
    for (const t of tasks) {
      if (cacheHit(plan.resultsDir, t, readResult(plan.resultsDir, t.id))) cachedIds.add(t.id);
    }
    // `after` is the complete dependency graph: validation rejects a {{result:}}
    // or forEach.from/when.from reference to a non-dependency, so nothing can
    // consume an output it does not declare. Fixed-point over it.
    for (let changed = true; changed;) {
      changed = false;
      for (const t of tasks) {
        if (cachedIds.has(t.id) && t.after.some((d) => !cachedIds.has(d))) {
          cachedIds.delete(t.id);
          changed = true;
        }
      }
    }
    for (const t of tasks) {
      if (!cachedIds.has(t.id)) continue;
      const prior = readResult(plan.resultsDir, t.id);
      ctx.record(t, "skipped", prior.durationMs ?? null, prior.tokens);
      if (t.isDigest) ctx.digestPath = writeDigestMd(plan.resultsDir, prior.output);
    }
  }

  Object.assign(ctx, createHeartbeatTick(ctx));

  // The try (not re-indented, to keep the diff readable) closes after the stopped sweep. Its
  // finally owns the heartbeat and the signal handlers on every exit path.
  try {

  for (;;) {
    // Block anything whose dependency chain is doomed (fail/timeout/rate-limit/
    // blocked). Independent branches keep going.
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of tasks) {
        if (ctx.state.get(t.id) === "pending" && ctx.depsDoomed(t)) {
          ctx.record(t, "blocked");
          changed = true;
        }
      }
    }

    let progressed = false;
    if (!ctx.stopRequested) {
      const seats = settleInline(tasks, {
        pending: (t) => ctx.state.get(t.id) === "pending",
        depsSatisfied: ctx.depsSatisfied, passesWhen: ctx.passesWhen,
        expandForEach: ctx.expandForEach, expandManifest: ctx.expandManifest,
        runAggregate: ctx.runAggregate, runManifestAggregate: ctx.runManifestAggregate,
        runCompute: ctx.runCompute, runIntegrate: ctx.runIntegrate,
      });
      progressed = seats.progressed;
      for (const t of seats.ready) {
        if (ctx.running.size >= plan.concurrency) break;
        // Spawn floor (D3): only once something is already running — the very
        // first leaf of a run must never be gated by the machine's headroom.
        if (ctx.running.size > 0 && ctx.memLow(cfg.minFreeMemMb)) { ctx.parkForMemory(t); continue; }
        ctx.launch(t);
      }
    }
    if (progressed) continue;

    // Stop wins: whatever is parked or waiting gets swept to failed:stopped below.
    if (ctx.running.size === 0 && (ctx.stopRequested || (ctx.memoryParked.size === 0 && ctx.retryWaiting === 0))) break;
    if (ctx.running.size > 0) {
      await Promise.race(ctx.running.values());
      // running is keyed by id and released on settlement; state is the truth about
      // what is alive. They can only disagree if a slot was stranded — which silently
      // narrows every later pass, so say so rather than degrading quietly.
      const live = [...ctx.running.keys()].filter((id) => ALIVE_STATES.has(ctx.state.get(id)));
      if (live.length !== ctx.running.size) {
        appendRunLog(plan.resultsDir, {
          ts: new Date().toISOString(), event: "slot-leak",
          held: ctx.running.size, live: live.length,
          stranded: [...ctx.running.keys()].filter((id) => !ALIVE_STATES.has(ctx.state.get(id))),
        });
      }
    } else {
      // nothing running, but leaves are sleeping out a backoff — idle until
      // the next retry timer re-arms one as pending
      await new Promise((resolve) => { ctx.wake = resolve; });
      ctx.wake = () => {};
    }
  }
  // A leaf that never got a slot (still pending) or was mid-backoff never runs
  // classifyFailure's stopped branch — say so here, or a stopped run leaves it
  // reading "pending" forever, indistinguishable from a run that just hasn't
  // started it yet.
  if (ctx.stopRequested) {
    for (const t of tasks) {
      if (ctx.state.get(t.id) === "pending" || ctx.state.get(t.id) === "retrying") ctx.record(t, "failed:stopped", 0);
    }
  }
  } finally {
    clearInterval(ctx.heartbeat); ctx.beat.stop();
    for (const timer of ctx.retryTimers) clearTimeout(timer);
    process.off("SIGINT", ctx.sigintHandler);
    process.off("SIGTERM", ctx.sigtermHandler);
  }

  // Ask mode changes exactly one row of a run the engine already finished: the
  // interrogated leaf gains duration/tokens from the ask on top of its prior
  // totals; every other row, and worktreesKept (nothing here re-collects a
  // tree), is carried over byte-verbatim from that finished run's summary.json.
  let summary;
  if (ask) {
    const priorSummary = readSummary(plan.resultsDir) ?? { started: ctx.started, tasks: [], worktreesKept: [] };
    const priorRow = priorSummary.tasks.find((t) => t.id === ask.taskId);
    const askedTask = tasks.find((t) => t.id === ask.taskId);
    const askedRow = {
      ...(priorRow ?? { id: ask.taskId, model: askedTask?.model, resultPath: resultPath(plan.resultsDir, ask.taskId) }),
      ...(askedTask ? ctx.durableIdentity(askedTask) : {}),
      state: "ok",
      durationMs: (priorRow?.durationMs ?? 0) + (ctx.durations.get(ask.taskId) ?? 0),
      tokens: addTokens(priorRow?.tokens ?? emptyTokens(), ctx.tokensMap.get(ask.taskId) ?? emptyTokens()),
      ...((priorRow?.numTurns != null || ctx.turnsMap.has(ask.taskId)) && { numTurns: (priorRow?.numTurns ?? 0) + (ctx.turnsMap.get(ask.taskId) ?? 0) }),
    };
    const mergedTasks = priorSummary.tasks.map((t) => (t.id === ask.taskId ? askedRow : t));
    summary = {
      ...priorSummary,
      finished: new Date().toISOString(),
      tasks: mergedTasks,
      worktreesKept: priorSummary.worktreesKept,
      totalTokens: mergedTasks.reduce((acc, t) => addTokens(acc, t.tokens ?? emptyTokens()), emptyTokens()),
    };
  } else {
    summary = {
      started: ctx.started,
      finished: new Date().toISOString(),
      ...(ctx.stopRequested && { stopped: true, stopReason: ctx.stopReason }),
      tasks: tasks.map((t) => ({
        id: t.id,
        // model + costUsd feed the estimate corpus (src/estimate.mjs loadCorpus)
        model: t.model,
        ...ctx.durableIdentity(t),
        state: ctx.state.get(t.id),
        durationMs: ctx.durations.get(t.id) ?? null,
        tokens: ctx.tokensMap.get(t.id) ?? null,
        ...(ctx.costMap.has(t.id) && { costUsd: ctx.costMap.get(t.id) }),
        ...(ctx.turnsMap.has(t.id) && { numTurns: ctx.turnsMap.get(t.id) }),
        resultPath: resultPath(plan.resultsDir, t.id),
      })),
      blocked: tasks.filter((t) => ctx.state.get(t.id) === "blocked").map((t) => t.id),
      worktreesKept: ctx.worktreesKept,
      totalTokens: [...ctx.tokensMap.values()].reduce(addTokens, emptyTokens()),
      ...(ctx.truncations.length && { truncations: ctx.truncations }),
      ...(ctx.refutations.length && { refutations: ctx.refutations }),
      ...(ctx.coverageGaps.length && { coverageGaps: ctx.coverageGaps }),
      ...(plan.estimate !== undefined && { estimate: plan.estimate }),
      ...(ctx.costWarnFired && { costWarnFired: true }),
    };
  }
  const summaryPath = _writeSummary(plan.resultsDir, summary);

  // Report mode: the leaf wrote the body AND its own title; the engine APPENDS a
  // one-line Run footnote (+ loud coverage lines). This is the first point where
  // every leaf's final row and the full truncation list are in hand, and the
  // digest, being the terminal node, has already finished.
  //
  // A report is about its subject — the footnote is the only run-mechanics the
  // reader sees, and it lives at the bottom. Best-effort BY CONTRACT: the agent
  // path (digest.md) is load-bearing, the human path is not; a report that fails
  // to materialise never takes the digest down with it.
  let reportPath = null;
  if (plan.digest?.report) {
    try {
      const p = digestReportPath(plan.resultsDir);
      if (existsSync(p)) {
        const body = readFileSync(p, "utf8").trimEnd();
        const footnote = renderProvenance({
          tasks: summary.tasks.filter((t) => t.id !== DIGEST_ID),
          truncations: ctx.truncations,
        });
        writeFileSync(p, `${body}\n\n---\n\n${footnote}`);
        reportPath = p;
      }
    } catch {
      reportPath = null; // a broken report is a missing report, never a broken run
    }
  }

  // requested-but-absent is a distinct, LOUD state — never silence
  const reportMissing = !!plan.digest?.report && !reportPath;

  return { summary, summaryPath, digestPath: ctx.digestPath, digestFailed: ctx.digestFailed, reportPath, reportMissing, worktreesKept: ctx.worktreesKept, memoryParks: ctx.memoryParkCount };
}
