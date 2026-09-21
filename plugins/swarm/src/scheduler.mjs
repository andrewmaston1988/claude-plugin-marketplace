import { mkdirSync, createWriteStream, existsSync, readFileSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { freemem } from "node:os";
import { join, basename } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { buildDispatch, createDispatchRegistry, toSpawnable, runnerOf } from "./dispatch.mjs";
import { isClaudeModel } from "./models.mjs";
import {
  buildDigestTask, DIGEST_ID,
  reportPath as digestReportPath, scratchPath as digestScratchPath,
} from "./digest.mjs";
import { effectivePlanDoc, resolveWorktreeName, makeReaches, isAgentless } from "./manifest.mjs";
import {
  initResultsDir, resultPath, writeResult, readResult, writeSummary, readSummary,
  writeManifestSnapshot, writeDigestMd, appendRunLog, renderRoster, formatTokens,
  renderProvenance, touchHeartbeat, stopPath, recordedSessionRecords, heartbeatPath, transcriptPath,
} from "./results.mjs";
import { parseReadCalls, computeCoverage, coverageErrorLines, TEMPLATE_RE } from "./coverage.mjs";
import { projectRun, formatEstimate } from "./estimate.mjs";
import {
  createRunnerParser, addTokens, emptyTokens, tokenTotal,
} from "./stream.mjs";
import { defaultProviderRegistry } from "./default-providers.mjs";
import { createSnapshotWriter, liveViewLines } from "./ui.mjs";
import { matchQuota, parseQuotaReset, DEFAULT_QUOTA_PATTERNS } from "./quota.mjs";
import { evalExpr, evalBool } from "./expr.mjs";
import { validateValue } from "./schema.mjs";
import { extractCitations, verifyCitations, citationErrorLines, annotateCitations } from "./citations.mjs";
import { removeCachedModel, ENTITLEMENT_RE } from "./discovery.mjs";
import { ALIVE_STATES } from "./runlog.mjs";
import * as defaultWorktree from "./worktree.mjs";

const RATE_LIMIT_RE = /rate.?limit|429|too many requests/i;
const OK_STATES = new Set(["ok", "skipped"]);

// Default io: real spawn (with Windows .cmd resolution), real fetch/clock,
// roster snapshots + closing lines to stdout. Every part is injectable so
// tests never hit the network or a real claude.
export function makeDefaultIo() {
  return {
    spawn: (cmd, args, opts) => {
      const s = toSpawnable([cmd, ...args]);
      return nodeSpawn(s.cmd, s.args, opts);
    },
    fetch: (...a) => globalThis.fetch(...a),
    now: () => Date.now(),
    freeMemMb: () => freemem() / 1048576,
    stdout: (line) => process.stdout.write(line + "\n"),
    snapshot: createSnapshotWriter(),
    maxLines: liveViewLines(),
    env: process.env,
  };
}

// Materialize {{result:id}} / {{resultPath:id}} against completed dep results.
// Returns the substituted prompt plus a record of every dep whose output was cut
// to fit the cap. Truncation is never silent: a verifier fed a PREFIX of its
// finder's findings would report the rest as checked when nothing checked them.
export function substituteTemplates(prompt, resultsDir, cap) {
  const truncations = [];
  const substituted = prompt.replace(TEMPLATE_RE, (whole, kind, id) => {
    if (kind === "resultPath") return resultPath(resultsDir, id);
    const res = readResult(resultsDir, id);
    const out = String(res?.output ?? "");
    if (out.length <= cap) return out;
    truncations.push({ depId: id, kept: cap, total: out.length });
    return out.slice(0, cap);
  });
  return { prompt: substituted, truncations };
}

const ITEM_RE = /\{\{(item(?:\.[^}]*)?|index)\}\}/g;

// Materialize {{item}}/{{item.field}}/{{index}} for one forEach clone. Runs at
// clone time and the result is final — launch never re-scans it, so item data
// that happens to contain template syntax stays literal (leaf outputs are
// untrusted data, not templates).
export function substituteItems(prompt, item, index) {
  return prompt.replace(ITEM_RE, (whole, expr) => {
    if (expr === "index") return String(index);
    let v = item;
    if (expr !== "item") {
      for (const seg of expr.slice(5).split(".")) {
        v = v !== null && typeof v === "object" && !Array.isArray(v) && Object.hasOwn(v, seg) ? v[seg] : undefined;
        if (v === undefined) break;
      }
    }
    if (v === undefined || v === null) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

// Classify a non-zero completion. Quota exhaustion outranks rate limits (a
// message can mention both; exhaustion is temporal — hours — while rate limits
// clear in seconds and are worth in-run retries). The only error-classification
// logic in the engine.
export function classifyFailure({ timedOut, output, stopped }, quotaPatterns = DEFAULT_QUOTA_PATTERNS) {
  if (stopped) return "failed:stopped";
  if (timedOut) return "failed:timeout";
  if (matchQuota(output, quotaPatterns)) return "quota";
  if (RATE_LIMIT_RE.test(output || "")) return "rate-limited";
  return "failed";
}

// The valve's target pick. Undefined when no id currently reads "running" —
// a stale `running` entry mid-settle must be a no-op, never a crash. `state`
// lags real liveness until the terminal record() call, so also require the
// child process itself to still be alive.
export function pickNewestRunning(ids, state, startedAt, children) {
  const alive = (id) => {
    const child = children.get(id);
    return child != null && child.exitCode === null && child.signalCode === null;
  };
  const runningIds = ids.filter((id) => state.get(id) === "running" && alive(id));
  if (runningIds.length === 0) return undefined;
  return runningIds.reduce((a, b) => ((startedAt.get(b) ?? 0) > (startedAt.get(a) ?? 0) ? b : a));
}

function tryParseJson(output) {
  const trimmed = String(output || "").trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch { /* not JSON */ }
  }
  return undefined;
}

// Schema, citations and read coverage share ONE corrective re-ask through the leaf's
// resumed session. Afterwards a schema miss is fatal; a refuted citation or coverage
// shortfall only annotates (the checker may be wrong). Runs before worktree collection.
async function enforceLeafContract(task, r, taskCwd, resultsDir, cfg, io, hooks, runtime) {
  const runner = runnerOf(task, cfg);
  // Coverage is proven from the leaf's OWN transcript: parse its Read calls and
  // check them against `mustRead`. The transcript on disk already holds the full
  // attempt history of the session (resume appends, D10), so a re-ask's reads are
  // seen on re-assessment. A missing/unreadable transcript → parseReadCalls sees
  // no assistant events → null → a total miss (fail closed).
  const coverageOf = () => {
    if (!task.mustRead) return null;
    let text = "";
    try { text = readFileSync(transcriptPath(resultsDir, task.id), "utf8"); } catch { /* unparseable */ }
    const reads = parseReadCalls(text, runner);
    return computeCoverage(task.mustRead, reads, {
      cwd: taskCwd,
      substitute: (s) => substituteTemplates(s, resultsDir, cfg.resultInlineCap ?? 4000).prompt,
    });
  };
  // Schema first; when the shape holds, mechanically verify any citation-shaped
  // instances (N3). A task with `mustRead` but no `returns` skips schema entirely
  // (`parsed` undefined is fine — `finish` then leaves the output untouched).
  const assess = (output) => {
    let parsed, schemaErrs, cite;
    if (task.returns) {
      parsed = tryParseJson(output);
      if (parsed === undefined) {
        schemaErrs = ["output is not JSON — reply with a single JSON value matching the schema"];
      } else {
        const errs = validateValue(parsed, task.returns);
        if (errs.length) schemaErrs = errs;
        else if (task.verifyCitations !== false) {
          const cits = extractCitations(parsed, task.returns);
          if (cits.length) cite = verifyCitations(cits, { cwds: [taskCwd, task.originalCwd] });
        }
      }
    }
    return { parsed, schemaErrs, cite, cov: coverageOf() };
  };
  const failText = (errs) => `returns validation failed:\n  - ${errs.join("\n  - ")}`;
  const logCitations = (cite) => appendRunLog(resultsDir, {
    ts: new Date().toISOString(), event: "citations", id: task.id,
    ...runtime?.identity?.(task),
    checked: cite.checked, drifted: cite.drifted.length, refuted: cite.refuted.length,
  });
  const logCoverage = (cov, retried) => appendRunLog(resultsDir, {
    ts: new Date().toISOString(), event: "coverage", id: task.id,
    status: cov.status, required: cov.required, read: cov.read, missed: cov.missed, retried,
  });
  // A schema-clean result: annotate every citation in place, re-serialize the
  // annotated output, and attach loud stats. Then stamp coverage. Refutations and
  // coverage shortfalls never fail the leaf — both are recorded, and the caller
  // surfaces an incomplete `coverage` in the closing block.
  const finish = (res, a, retried = false) => {
    let out = res;
    if (a.cite) {
      const cite = a.cite;
      annotateCitations(cite);
      logCitations(cite);
      out = {
        ...out,
        output: JSON.stringify(a.parsed),
        citations: { checked: cite.checked, drifted: cite.drifted.length, refuted: cite.refuted.length },
      };
      if (cite.refuted.length) out.citationRefuted = cite.refuted.map((c) => ({ path: c.path, reason: c.reason }));
    }
    if (a.cov) {
      logCoverage(a.cov, retried);
      out = { ...out, coverage: { status: a.cov.status, required: a.cov.required, read: a.cov.read, missed: a.cov.missed } };
    }
    return out;
  };
  const failSchema = (res, errs, suffix = "") => ({
    ...res, ok: false, output: failText(errs) + suffix, schemaErrors: errs,
  });

  const a1 = assess(r.output);
  const schema1 = a1.schemaErrs?.length ? a1.schemaErrs : null;
  const refuted1 = a1.cite?.refuted.length || 0;
  const covMiss1 = a1.cov && a1.cov.status !== "complete";

  // Clean, or only-annotatable-with-no-session: record and finish (never fail).
  if (!schema1 && !refuted1 && !covMiss1) return finish(r, a1, false);
  if (!r.sessionId) {
    if (schema1) return failSchema(r, schema1, "\n(no session id — re-ask unavailable)");
    return finish(r, a1, false);
  }

  appendRunLog(resultsDir, {
    ts: new Date().toISOString(), event: "leaf-contract-retry", id: task.id,
    ...runtime?.identity?.(task),
  });
  // One retry prompt carries every class that fired, in order: schema (carries the
  // schema itself — "expected object" alone doesn't name fields), citations (name
  // file/line/fix), then coverage (name each unread range as a literal Read call).
  const blocks = [];
  if (schema1) blocks.push(
    `Your output did not match the task's returns schema:\n  - ${schema1.join("\n  - ")}\n` +
    `The required schema is:\n${JSON.stringify(task.returns, null, 2)}`,
  );
  if (refuted1) blocks.push(
    `Some citations in your output could not be verified against the actual files:\n  - ${citationErrorLines(a1.cite.refuted).join("\n  - ")}`,
  );
  if (covMiss1) blocks.push(
    `You did not read everything this task requires. Read each of the following with the Read tool, exactly as stated, then give your corrected answer:\n  - ${coverageErrorLines(a1.cov.gaps, { indexErrors: a1.cov.errors }).join("\n  - ")}`,
  );
  // A mustRead-only task may be a prose leaf: demanding JSON there would replace its answer.
  const closing = task.returns
    ? "Reply with ONLY the corrected JSON — no prose, no fences."
    : "Reply with your complete corrected answer, in the same form the task originally asked for.";
  const retryPrompt = `${blocks.join("\n\n")}\n${closing}`;
  const leafLog = createWriteStream(join(resultsDir, "results", `${task.id}.log`), { flags: "a" });
  const r2 = await runTask({ ...task, cwd: taskCwd, resume: r.sessionId }, retryPrompt, cfg, io, leafLog, hooks, runtime);

  const combined = {
    ...r,
    durationMs: r.durationMs + r2.durationMs,
    tokens: addTokens(r.tokens || emptyTokens(), r2.tokens || emptyTokens()),
    ...((r.costUsd != null || r2.costUsd != null) && { costUsd: (r.costUsd || 0) + (r2.costUsd || 0) }),
    sessionId: r2.sessionId ?? r.sessionId,
    schemaRetried: true,
  };
  // Re-ask process itself failed: a schema miss is still fatal; a citation/coverage
  // correction that never ran falls back to the ORIGINAL output and its first-pass
  // annotations — a failed correction must not destroy findings the first pass made.
  if (!r2.ok) {
    if (schema1) return failSchema(combined, [`re-ask failed (exit ${r2.exit}): ${r2.output.slice(0, 200)}`]);
    return finish({ ...combined, output: r.output }, a1, true);
  }
  const a2 = assess(r2.output);
  if (a2.schemaErrs?.length) return failSchema(combined, a2.schemaErrs);
  return finish({ ...combined, ok: true, output: r2.output }, a2, true);
}

// Exported for src/ask.mjs — interrogation reuses the exact dispatch path.
export function runTask(task, prompt, cfg, io, leafLog, { onTokens, onActivity, onChild, onSession } = {}, runtime = {}) {
  return new Promise((resolve) => {
    let dispatch;
    try {
      dispatch = buildDispatch(task, prompt, cfg, {
        providerRegistry: runtime.providerRegistry,
        runnerRegistry: runtime.runnerRegistry,
        cache: runtime.cache,
      });
    } catch (e) {
      const done = () => resolve({
        ok: false, exit: null, durationMs: 0, output: `dispatch error: ${e.message}`, raw: "", timedOut: false,
        tokens: emptyTokens(), errorCode: e.code || "DISPATCH_ERROR",
        ...(task.provider && { provider: task.provider }),
      });
      if (leafLog) leafLog.end(done);
      else done();
      return;
    }
    const { argv, env, provider, runner, parser: parserName } = dispatch;
    const runnerDescriptor = runtime.runnerRegistry?.get?.(runner);
    const started = io.now();
    let child;
    try {
      child = io.spawn(argv[0], argv.slice(1), {
        cwd: task.cwd,
        // A leaf is a headless session: CORRELATION_ID is the marker every
        // session hook already honours to stay out of autonomous runs (the
        // checkpoint plugin's resume offer, keepalive tick, stop nudge and
        // pre-compact snapshot all exit on it). Without it the resume offer
        // reaches the leaf's first turn — a model that follows it literally
        // burns the leaf (mistral-large-3, twice, 2026-08-27). A caller's own
        // CORRELATION_ID wins so a pipeline-launched swarm keeps its id.
        // SWARM_LEAF is the one marker a hook can trust to mean "this IS a leaf".
        // Unlike CORRELATION_ID it never yields to a caller's value: a parent's
        // correlation id legitimately flows through, but a parent claiming to be a
        // leaf would arm foreground-guard's deny in an interactive session. It is
        // spread LAST so neither the inherited env nor a dispatch env can unset it.
        // SWARM_LEAF_GUARD/_PROJECT are the engine's own resolution of task.leafGuard
        // (set by manifest.mjs's guardFor, never by the task's own env) — same
        // reasoning as SWARM_LEAF: a task cannot forge or unset its own guard.
        env: {
          ...(io.env || process.env),
          CORRELATION_ID: (io.env || process.env).CORRELATION_ID || `swarm:${task.id}`,
          ...env,
          SWARM_LEAF: "1",
          ...(task.leafGuard && { SWARM_LEAF_GUARD: task.leafGuard.command, SWARM_LEAF_GUARD_PROJECT: task.leafGuard.name }),
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      // same contract as settle(): the log is durable before the task resolves
      const done = () => resolve({
        ok: false, exit: null, durationMs: 0, output: `spawn error: ${e.message}`, raw: "", timedOut: false,
        tokens: emptyTokens(), errorCode: e.code, provider, runner,
      });
      if (leafLog) leafLog.end(`spawn error: ${e.message}\n`, done);
      else done();
      return;
    }
    onChild?.(child);
    let raw = "";
    let timedOut = false;
    let settled = false;
    // Every runner emits the same contract. Raw stdout/stderr is retained only
    // for diagnostics and failure classification; it never decides whether a
    // non-Claude runner completed successfully.
    const events = [];
    let streamError = null;
    const emit = (event) => {
      events.push(event);
      if (event.type === "session" && event.sessionId) onSession?.(event.sessionId);
      if (event.type === "usage" && event.usage) onTokens?.(event.usage);
      if (event.type === "activity" && event.activity) {
        const activity = typeof event.activity === "string"
          ? event.activity
          : event.activity.label || event.activity.name || event.activity.command || JSON.stringify(event.activity);
        onActivity?.(activity);
      }
      if (event.type === "error") streamError = event.error || { code: "runner_error", message: "runner failed" };
    };
    const parser = typeof runnerDescriptor?.createParser === "function"
      ? runnerDescriptor.createParser(emit, { task, config: cfg, provider, runner })
      : createRunnerParser(parserName, { emit });
    // Progressive capture: stream to results/<id>.log as data arrives so a
    // user can tail an individual leaf mid-run (with stream-json, the tail
    // shows tool-call events live).
    child.stdout?.on("data", (d) => { raw += d; leafLog?.write(d); parser.feed(String(d)); });
    child.stderr?.on("data", (d) => { raw += d; leafLog?.write(d); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* already gone */ }
    }, task.timeoutMs);
    if (timer.unref) timer.unref();
    // The leaf log must be FLUSHED before the task resolves. end() is
    // fire-and-forget, so resolving straight after it let runPlan finish with
    // writes still in flight: the run reported done while results/<id>.log was
    // still being written, and anything that touched the results dir on that
    // signal (a cleanup, an archive, a reader) raced the flush.
    const flushLog = () => new Promise((res) => {
      if (!leafLog || leafLog.writableFinished) return res();
      leafLog.end(res);
    });

    const settle = (exit, errMsg, errorCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parser.end();
      if (errMsg) raw += (raw ? "\n" : "") + errMsg;
      const parsed = parser.result();
      let classified = null;
      try {
        classified = runnerDescriptor?.classifyExit?.(exit, parsed, { ...task, provider });
      } catch (e) {
        streamError ||= { code: "runner_classify", message: e.message };
      }
      // The Claude CLI has a supported legacy/plain-text mode in the wild. It
      // produces no canonical data at all, so retain the old raw-output escape
      // hatch only for Claude. Codex and future runners must emit a terminal
      // contract event or they fail closed.
      const hadCanonicalData = events.some((event) => event.type !== "error");
      const legacyPlain = parserName === "claude"
        && (!streamError || streamError.code === "missing_terminal")
        && !hadCanonicalData && (
        raw.trim().length > 0 || (exit === 0 && !timedOut)
      );
      const parsedError = legacyPlain ? null : (streamError || parsed?.error || classified?.error);
      const terminal = classified?.terminal ?? parsed?.terminal === true;
      const cleanFinish = legacyPlain || (terminal && !parsedError);
      const stopReason = parsed?.stopReason || (cleanFinish && parserName === "claude" ? "end_turn" : null);
      const failPrefix = terminal && parsedError && parsedError.code !== "missing_terminal"
        ?`leaf ended with a runner error: ${parsedError.message || parsedError.code}`
        : "leaf terminated mid-stream (no terminal event) — its session died before completing; re-dispatch a fresh manifest, do not kill or diff-hunt.";
      const output = cleanFinish
        ? (parsed?.output || (legacyPlain ? String(raw) : ""))
        : `${failPrefix}\n${parsed?.output || String(raw)}`;
      flushLog().then(() => resolve({
        ok: exit === 0 && !timedOut && !parsedError && cleanFinish,
        exit,
        durationMs: io.now() - started,
        output: output || (cleanFinish ? String(classified?.output || "") : output),
        raw: String(raw),
        stopReason,
        timedOut,
        errorCode: errorCode || parsedError?.code,
        tokens: parsed?.usage || emptyTokens(),
        costUsd: parsed?.costUsd,
        numTurns: parsed?.numTurns,
        realModel: parsed?.realModel ?? null,
        sessionId: parsed?.sessionId ?? null,
        apiKeySource: parsed?.apiKeySource ?? null,
        provider,
        runner,
      }));
    };
    child.on("error", (e) => settle(null, `spawn error: ${e.message}`, e.code));
    child.on("close", (code) => settle(code));
  });
}

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
  const runtime = { providerRegistry, runnerRegistry: effectiveRunnerRegistry };
  const providerCache = cfg.modelCache || cfg.models || [];
  const resolvedIdentity = (task) => providerRegistry.resolve(task, { cache: providerCache, config: cfg });
  // Hand-built unit plans predate durable provider identity. Keep their old
  // compact log shape, while every normalized manifest task (which has an
  // explicit provider) carries the provider and derived runner everywhere.
  const durableIdentity = (task) => {
    if (task?.provider === undefined) return {};
    const identity = resolvedIdentity(task);
    return { provider: identity.provider, runner: providerRegistry.get(identity.provider).runnerId };
  };
  runtime.identity = durableIdentity;
  initResultsDir(plan.resultsDir);
  // A prior `swarm stop` leaves its marker and no other engine is live here (cmdRun
  // refuses one): clear it before any await, so a stop landing during startup still counts.
  rmSync(stopPath(plan.resultsDir), { force: true });
  // P1: the run records its own intent — the effective plan persists beside
  // the outcomes it produced, so the corpus can answer "what was asked".
  writeManifestSnapshot(plan.resultsDir, effectivePlanDoc(plan));

  const children = new Map(); // id -> live child process, for requestStop to kill
  let wake = () => {};        // resolves the loop's idle wait when a retry re-arms
  let stopRequested = false;
  let stopReason = null;
  // Cooperative stop: a control file, not a pid-kill — Windows TerminateProcess
  // runs no handler, so an external kill can never route through this, and a
  // pid the OS has since reused must never be mistaken for this run's engine.
  // Idempotent: the first caller (stop file or a signal) wins. Registered before
  // any await below so a signal during the health/quota preflight is caught too.
  const requestStop = (reason) => {
    if (stopRequested) return;
    stopRequested = true;
    stopReason = reason;
    appendRunLog(plan.resultsDir, { ts: new Date().toISOString(), event: "run-stop", reason });
    for (const child of children.values()) {
      try { child.kill(); } catch { /* already gone */ }
    }
    wake();
  };
  const onSignal = (sig) => () => requestStop(`signal:${sig}`);
  const sigintHandler = onSignal("SIGINT");
  const sigtermHandler = onSignal("SIGTERM");
  process.once("SIGINT", sigintHandler);
  process.once("SIGTERM", sigtermHandler);

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
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigtermHandler);
    throw e;
  }

  // The approval-surface estimate (computed by the CLI) echoes at run start so
  // the consent line and the closing actual sit in the same transcript.
  if (plan.estimate !== undefined) io.stdout(formatEstimate(plan.estimate));

  const started = new Date().toISOString();
  // Read before this run's run-start is appended: every session a previous engine
  // saw start, including leaves it died before settling.
  const recordedSessions = force ? new Map() : recordedSessionRecords(plan.resultsDir);
  // run-start line lets `status` derive pending tasks (ids never seen since
  // the latest run-start are pending) and carries models for the roster view.
  // pid: lets a reader tell a killed engine (no summary, pid gone) from a live one.
  // launcher: the dispatching session's CLAUDE_CODE_SESSION_ID — absent when the
  // engine runs outside a session, so the run belongs to nobody rather than to
  // whoever asks about it next. A resume appends a fresh run-start, re-stamping.
  appendRunLog(plan.resultsDir, {
    ts: started, event: "run-start", pid: process.pid,
    ...(process.env.CLAUDE_CODE_SESSION_ID ? { launcher: process.env.CLAUDE_CODE_SESSION_ID } : {}),
    ...(ask && { ask: ask.taskId }),
    tasks: tasks.map((t) => ({ id: t.id, model: t.model, ...durableIdentity(t) })),
  });
  const runStartMs = io.now();
  const state = new Map(tasks.map((t) => [t.id, "pending"]));
  const durations = new Map();
  const tokensMap = new Map();
  const costMap = new Map();      // id -> costUsd, real-key leaves only (feeds the corpus)
  // Single-shot projection warn: spend so far vs worst-case remaining leaves.
  let completedLeaves = 0;
  let spentTokens = 0;
  let spentUsd = 0;
  let costIsRealComplete = true;  // every completed leaf so far: real-key-billed costUsd
  let costWarnFired = false;
  const startedAt = new Map();
  const activityMap = new Map();  // id -> latest tool-call description
  const lastEventAt = new Map();  // id -> ms of last stream event (liveness)
  const lastActivityLogAt = new Map();
  const attempts = new Map();     // id -> retries consumed on the current model
  const usedFallback = new Set(); // ids already switched to their fallbackModel
  let retryWaiting = 0;           // leaves sleeping out a backoff
  // Memory survivability (D3/D4): ids parked because free memory is under
  // minFreeMemMb (spawn floor, or a valve kill's landing state); ids the valve
  // has just killed, read once by launch() to classify that settle as a park
  // rather than a failure. memoryParkCount is the closing block's leaf count.
  const memoryParked = new Set();
  const memoryStopped = new Set();
  let memoryParkCount = 0;
  const memLow = (mb) => mb > 0 && io.freeMemMb() < mb;
  const worktreesKept = [];
  let digestPath = null;
  let digestFailed = false;

  // Tasks sharing a worktree name form one ordered chain in one tree. Only its
  // final link collects — collect() destroys a tree whose diff is empty, and a
  // read-only reviewer mid-chain changes nothing. Only its first link may be
  // --force reset, or re-running a later link would scrub its predecessors'
  // commits. A task with a private tree is simply a group of one.
  // normalizeTasks derives worktreeName, but runPlan also accepts hand-built
  // plans — resolveWorktreeName covers both rather than silently skipping isolation.
  const nameOf = resolveWorktreeName;

  // The branch a task id resolves to, for `integrate.from`. The id may name a task
  // whose worktree name differs from it, or (defensively) no task at all.
  const branchOf = (srcId) => {
    const src = tasks.find((o) => o.id === srcId);
    return worktree.branchNameFor(
      src ? { ...src, worktreeName: nameOf(src) ?? src.id } : { id: srcId }, cfg);
  };

  // Tasks any integrate node names: their branches must survive the sweep even
  // when empty, because the merge needs the ref, not its contents.
  const integrateSources = new Set(tasks.flatMap((t) => t.integrate?.from ?? []));

  // A forEach parent named in integrate.from owns no branch itself — its clones
  // do. A clone's own id is never authored into integrate.from (it doesn't
  // exist until expansion), so its protection is inherited from its parent.
  const cloneParentOf = (id) => { const m = /^(.+)\[\d+\]$/.exec(id); return m?.[1]; };
  const isIntegrateSourceId = (id) => integrateSources.has(id) || integrateSources.has(cloneParentOf(id));

  // integrate.from naming a forEach parent means every clone that expanded
  // from it, resolved at merge time in index order — the parent itself never
  // gets a branch (D1, foreach-integrate-fold-back). A plain id passes through.
  const resolveIntegrateFrom = (fromList) => fromList.flatMap((id) => {
    const t = tasks.find((o) => o.id === id);
    return t?.aggregate ? t.after : [id];
  });

  const groupMembers = new Map();   // name -> [task ids, in manifest order]
  const groupFinal = new Map();
  const groupFirst = new Map();
  // Rebuilt after every splice: forEach clones and manifest children join the
  // run mid-flight, and a group map that predates them would leave their trees
  // uncollected and un-resettable.
  const rebuildGroups = () => {
    groupMembers.clear(); groupFinal.clear(); groupFirst.clear();
    for (const t of tasks) {
      const n = nameOf(t);
      if (!n) continue;
      if (!groupMembers.has(n)) groupMembers.set(n, []);
      groupMembers.get(n).push(t.id);
    }
    // Reachability must be GLOBAL, not group-local: two members of one tree can
    // be ordered entirely through tasks in other groups (helper -> migrate-x ->
    // cleanup, where migrate-x has its own tree). A group-local scan sees no
    // edge, picks the FIRST task as the collector, and sweeps the tree before
    // the last member has run — silently dropping its work. This mirrors
    // validateWorktreeGroups, which already permits such a topology.
    const reaches = makeReaches(tasks);
    for (const [name, ids] of groupMembers) {
      groupFinal.set(name, ids.find((id) => !ids.some((o) => o !== id && reaches(o, id))) ?? ids[ids.length - 1]);
      groupFirst.set(name, ids.find((id) => !ids.some((o) => o !== id && reaches(id, o))) ?? ids[0]);
    }
  };
  rebuildGroups();

  let lastPaintMs = 0;
  const paint = (force = true) => {
    if (!io.snapshot) return;
    if (!force && io.now() - lastPaintMs < 1000) return; // token ticks repaint at most 1/s
    lastPaintMs = io.now();
    io.snapshot(renderRoster({
      title: basename(plan.resultsDir),
      tasks: tasks.map((t) => ({
        id: t.id, model: t.model, state: state.get(t.id), ...durableIdentity(t),
        durationMs: durations.get(t.id),
        startedMs: startedAt.get(t.id),
        tokens: tokensMap.get(t.id),
        activity: activityMap.get(t.id),
        // a leaf that never emitted an event counts as quiet since launch
        lastEventMs: lastEventAt.get(t.id) ?? startedAt.get(t.id),
      })),
      now: io.now(),
      startedMs: runStartMs,
      quietWarnMs: (cfg.quietWarnSecs ?? 60) * 1000,
      maxLines: io.maxLines ?? null,
    }));
  };

  const record = (task, st, durationMs, tokens, note) => {
    state.set(task.id, st);
    if (st === "running") startedAt.set(task.id, io.now());
    if (durationMs != null) durations.set(task.id, durationMs);
    if (tokens && tokenTotal(tokens) + tokens.cacheRead > 0) tokensMap.set(task.id, tokens);
    appendRunLog(plan.resultsDir, {
      ts: new Date().toISOString(), id: task.id, state: st,
      ...durableIdentity(task),
      ...(durationMs != null && { durationMs }),
      ...(tokensMap.has(task.id) && st !== "running" && { tokens: tokensMap.get(task.id) }),
      ...(note && { note }),
    });
    paint();
  };

  // Live ticks from a leaf's stream: token totals and tool-call activity both
  // land in run.log (feeding the status view + statusline glyph) plus a
  // throttled roster repaint. Activity log lines are rate-limited per leaf —
  // a busy leaf calls tools far faster than a watcher needs.
  const streamHooks = (task) => ({
    onChild: (child) => children.set(task.id, child),
    // Durable the moment the stream names it: an engine that dies before this
    // leaf settles writes no result, and without this line resume starts cold.
    onSession: (sessionId) => {
      appendRunLog(plan.resultsDir, { ts: new Date().toISOString(), id: task.id, event: "session", sessionId, ...durableIdentity(task) });
    },
    onTokens: (totals) => {
      tokensMap.set(task.id, totals);
      lastEventAt.set(task.id, io.now());
      appendRunLog(plan.resultsDir, { ts: new Date().toISOString(), id: task.id, event: "tokens", tokens: totals, ...durableIdentity(task) });
      paint(false);
    },
    onActivity: (desc) => {
      activityMap.set(task.id, desc);
      lastEventAt.set(task.id, io.now());
      if (io.now() - (lastActivityLogAt.get(task.id) ?? 0) >= 2000) {
        lastActivityLogAt.set(task.id, io.now());
        appendRunLog(plan.resultsDir, { ts: new Date().toISOString(), id: task.id, event: "activity", activity: desc, ...durableIdentity(task) });
      }
      paint(false);
    },
  });

  // Park a leaf for delayMs, then hand it back to the scheduler loop as
  // pending. The concurrency slot frees during the wait (the launch promise
  // resolves); depsDoomed treats 'retrying' as alive so dependents hold.
  const scheduleRetry = (task, delayMs, note) => {
    retryWaiting++;
    state.set(task.id, "retrying");
    activityMap.set(task.id, note);
    appendRunLog(plan.resultsDir, { ts: new Date().toISOString(), id: task.id, state: "retrying" });
    paint();
    // Deliberately ref'd (unlike the heartbeat): a parked retry is pending
    // work, and with nothing else running an unref'd timer lets the event
    // loop drain — node exits 13 with the run's top-level await unsettled.
    setTimeout(() => {
      retryWaiting--;
      state.set(task.id, "pending");
      activityMap.delete(task.id);
      wake();
    }, delayMs);
  };

  // Park a leaf for low memory: no timer. The heartbeat (ref'd for as long as
  // anything is parked — see below) is what re-drives it once io.freeMemMb()
  // clears minFreeMemMb again; a parked leaf never spawned, so nothing here
  // touches attempts.
  const parkForMemory = (task) => {
    memoryParked.add(task.id);
    memoryParkCount++;
    state.set(task.id, "retrying");
    activityMap.set(task.id, `⏸ low memory — ${(io.freeMemMb() / 1024).toFixed(1)} GB free`);
    appendRunLog(plan.resultsDir, { ts: new Date().toISOString(), id: task.id, state: "retrying", note: "memory-park" });
    paint();
    if (heartbeat.ref) heartbeat.ref();
  };

  // Resume: an existing ok result satisfies the task without re-running it —
  // its recorded duration and tokens still count in roster and summary.
  //
  // A cached result is only valid if every input that produced it is unchanged.
  // For a dependent, the inputs ARE its dependencies' outputs — so a task whose
  // upstream is re-executing must re-execute too, however good its own last run
  // looked. Skipping on `prior.ok` alone let a verifier keep a verdict about
  // findings that no longer existed, and re-stamped digest.md with the previous
  // pass's body while reporting success. Invalidation is transitive: in A → B → C,
  // a re-running A invalidates C, which never names A.
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
      record(t, priorRow?.state ?? "skipped", priorRow?.durationMs ?? null, priorRow?.tokens ?? null);
    }
  } else if (!force) {
    for (const t of tasks) {
      const prior = readResult(plan.resultsDir, t.id);
      if (prior && prior.ok === true) cachedIds.add(t.id);
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
      record(t, "skipped", prior.durationMs ?? null, prior.tokens);
      if (t.isDigest) digestPath = writeDigestMd(plan.resultsDir, prior.output);
    }
  }

  const running = new Map();  // id -> promise resolving to task id

  // Heartbeat: touch the liveness file every tick — even while every leaf is
  // parked in backoff, since a reader must never mistake a resting engine for
  // a dead one — and repaint while anything runs so elapsed and live tokens
  // tick even between state changes. unref'd — never holds the process open.
  // Declared above the try: the closing summary reads them after it.
  const truncations = [];
  // Citation refutations that Stage 1 kept — surfaced loud in the closing block,
  // the same register as a truncation: coverage the reader must not mistake for full.
  const refutations = [];
  // Coverage shortfalls kept (D9), surfaced in the same loud closing channel.
  const coverageGaps = [];
  const heartbeatMs = Math.max(50, (cfg.heartbeatSecs ?? 15) * 1000);
  touchHeartbeat(plan.resultsDir, started, process.pid);
  const heartbeat = setInterval(() => {
    touchHeartbeat(plan.resultsDir, new Date().toISOString(), process.pid);
    if (!stopRequested && existsSync(stopPath(plan.resultsDir))) requestStop("stop-file");
    // Valve (D4): a deliberate, targeted kill — cheaper than the whole run
    // dying to an OOM. Only when there is a second running leaf to fall back
    // to; children.get may already be gone if it settled between ticks.
    if (running.size > 1 && memLow(cfg.valveFreeMemMb)) {
      const newest = pickNewestRunning([...running.keys()], state, startedAt, children);
      if (newest !== undefined) {
        memoryStopped.add(newest);
        try { children.get(newest)?.kill(); } catch { /* already gone */ }
      }
    }
    // Re-drive (D3): once memory has recovered past the floor, OR nothing is
    // running at all (the spawn floor's own rule: never block the first leaf),
    // hand every parked leaf back as pending — the floor re-parks the rest.
    if (memoryParked.size > 0 && (running.size === 0 || !memLow(cfg.minFreeMemMb))) {
      for (const id of memoryParked) {
        state.set(id, "pending");
        activityMap.delete(id);
      }
      memoryParked.clear();
      if (heartbeat.unref) heartbeat.unref();
      wake();
    }
    if (running.size > 0) paint();
  }, heartbeatMs);
  if (heartbeat.unref) heartbeat.unref();

  // The try (not re-indented, to keep the diff readable) closes after the stopped sweep. Its
  // finally owns the heartbeat and the signal handlers on every exit path.
  try {

  const depsSatisfied = (t) => t.after.every((d) => OK_STATES.has(state.get(d)));
  const depsDoomed = (t) => t.after.some((d) => {
    const s = state.get(d);
    return s !== undefined && !OK_STATES.has(s) && !ALIVE_STATES.has(s);
  });

  // A dependency's value for expressions and forEach: parsed JSON when the
  // leaf produced any, else the raw output string.
  const valueOf = (id) => {
    const res = readResult(plan.resultsDir, id);
    if (!res) return null;
    return res.outputJson !== undefined ? res.outputJson : String(res.output ?? "");
  };
  const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  const digPath = (v, path) => {
    if (!path) return v;
    let cur = v;
    for (const seg of path.split(".")) {
      cur = cur !== null && typeof cur === "object" && !Array.isArray(cur) && Object.hasOwn(cur, seg) ? cur[seg] : undefined;
      if (cur === undefined) return undefined;
    }
    return cur;
  };
  // Both truncation paths share one loud channel: run.log event, stdout warning,
  // run-summary field, closing block. A cut only the engine knows about is how an
  // unverified finding ends up reported as verified.
  const notePromptTruncations = (task, list) => {
    for (const t of list) {
      truncations.push({ kind: "prompt", id: task.id, depId: t.depId, kept: t.kept, total: t.total });
      appendRunLog(plan.resultsDir, {
        ts: new Date().toISOString(), event: "truncate-prompt", id: task.id,
        depId: t.depId, kept: t.kept, total: t.total,
      });
      io.stdout(`⚠ ${task.id}: {{result:${t.depId}}} inlined ${t.kept} of ${t.total} chars — the rest was NOT seen; use {{resultPath:${t.depId}}} to pass the whole result`);
    }
  };

  // Evaluate a task's when-gate once its deps are satisfied. True ⇒ proceed;
  // false ⇒ the task settled here (skipped, or failed on an expression error).
  // Skips write no result file — a when re-evaluates deterministically on resume.
  const passesWhen = (task) => {
    if (!task.when) return true;
    let pass;
    try {
      pass = evalBool(task.when.expr, { value: valueOf(task.when.from) });
    } catch (e) {
      writeResult(plan.resultsDir, task.id, { id: task.id, model: task.model, ...durableIdentity(task), ok: false, exit: null, durationMs: 0, output: `when failed: ${e.message}` });
      record(task, "failed", 0);
      return false;
    }
    if (pass) return true;
    record(task, "skipped", null, undefined, `when: ${task.when.expr} → false`);
    return false;
  };

  // compute steps run inline — no spawn, no slot, zero tokens. The result is a
  // first-class task result so {{result:}} and forEach.from consume it as usual.
  // Spliced child computes bind deps by their LOCAL ids via depAliases — the
  // expression text is never rewritten.
  const runCompute = (task) => {
    record(task, "running");
    const t0 = io.now();
    let result;
    try {
      const scope = { deps: task.depAliases
        ? Object.fromEntries(Object.entries(task.depAliases).map(([local, full]) => [local, valueOf(full)]))
        : Object.fromEntries(task.after.map((d) => [d, valueOf(d)])) };
      const v = evalExpr(task.compute, scope);
      result = {
        id: task.id, model: task.model, ...durableIdentity(task), ok: true, exit: 0, durationMs: io.now() - t0,
        output: typeof v === "string" ? v : JSON.stringify(v),
        outputJson: v,
      };
    } catch (e) {
      result = { id: task.id, model: task.model, ...durableIdentity(task), ok: false, exit: null, durationMs: io.now() - t0, output: `compute failed: ${e.message}` };
    }
    writeResult(plan.resultsDir, task.id, result);
    record(task, result.ok ? "ok" : "failed", result.durationMs);
  };

  // Agentless merge: fold the named tasks' branches into the target worktree.
  // A conflict is NOT a failure — the markers stay in the tree and the paths are
  // reported, because the next link is a model that can read and resolve them.
  const runIntegrate = (task) => {
    record(task, "running");
    const t0 = io.now();
    let result;
    try {
      const sources = resolveIntegrateFrom(task.integrate.from).map(branchOf);
      const out = worktree.integrate(
        { ...task, worktreeName: task.integrate.into, sources }, cfg, plan.resultsDir,
        { repo: task.originalCwd || plan.cwd });
      const payload = { into: task.integrate.into, branch: out.branch, merged: out.merged, conflicts: out.conflicts };
      result = {
        id: task.id, model: task.model, ...durableIdentity(task), ok: true, exit: 0, durationMs: io.now() - t0,
        output: out.conflicts.length
          ? `merged ${out.merged.join(", ")} into ${out.branch}; conflicts left in the tree for the next leaf to resolve: ${out.conflicts.join(", ")}`
          : `merged ${out.merged.join(", ")} into ${out.branch} cleanly`,
        outputJson: payload,
      };
      appendRunLog(plan.resultsDir, {
        ts: new Date().toISOString(), event: "integrate", id: task.id,
        into: task.integrate.into, merged: out.merged.length, conflicts: out.conflicts.length,
      });
    } catch (e) {
      result = { id: task.id, model: task.model, ...durableIdentity(task), ok: false, exit: null, durationMs: io.now() - t0, output: `integrate failed: ${e.message}` };
    }
    writeResult(plan.resultsDir, task.id, result);
    record(task, result.ok ? "ok" : "failed", result.durationMs);
  };

  // Expansion morphs the parent into a pending aggregate over its clones, so
  // dependents keep depending on the parent id. Both template passes run here;
  // promptFinal stops the launch-time pass from re-scanning substituted data.
  const expandForEach = (task) => {
    const src = valueOf(task.forEach.from);
    const sel = digPath(src, task.forEach.path);
    if (!Array.isArray(sel)) {
      const where = task.forEach.path ? `'${task.forEach.from}'.${task.forEach.path}` : `'${task.forEach.from}'`;
      writeResult(plan.resultsDir, task.id, {
        id: task.id, model: task.model, ...durableIdentity(task), ok: false, exit: null, durationMs: 0,
        output: `forEach failed: ${where} is ${typeOf(sel === undefined ? null : sel)} — expected a JSON array (check forEach.path against the dependency's output)`,
      });
      record(task, "failed", 0);
      return;
    }
    const items = sel.slice(0, task.forEach.maxItems);
    const truncated = sel.length > items.length;
    // A childPlan parent clones manifest NODES (one child copy per item —
    // {{item}} substitutes at each clone's own expansion); a plain parent
    // clones prompt leaves as before.
    let base = "";
    if (!task.childPlan) {
      const sub = substituteTemplates(task.prompt, plan.resultsDir, cfg.resultInlineCap ?? 4000);
      base = sub.prompt;
      notePromptTruncations(task, sub.truncations); // every clone inherits the cut base
    }
    const clones = items.map((item, i) => ({
      ...task,
      id: `${task.id}[${i}]`,
      // Clones run concurrently, so each needs its OWN tree — inheriting the
      // parent's name would put every clone in one directory. A shared name is
      // rejected at validation; the private shorthand lands here. Dash, not
      // the id's own `[i]` bracket — brackets are invalid in a git ref, and
      // this name feeds branchNameFor() straight into `git worktree add`.
      ...(task.worktreeName !== undefined && { worktreeName: `${task.id}-${i}` }),
      ...(task.childPlan
        ? { manifestItem: item, manifestIndex: i }
        : { prompt: substituteItems(base, item, i), promptFinal: true }),
      when: undefined,
      forEach: undefined,
      after: [...task.after],
    }));
    appendRunLog(plan.resultsDir, {
      ts: new Date().toISOString(), event: "expand", id: task.id, model: task.model, ...durableIdentity(task),
      clones: clones.length, ...(truncated && { truncated: true, total: sel.length }),
    });
    if (truncated) {
      truncations.push({ kind: "forEach", id: task.id, kept: items.length, total: sel.length });
      io.stdout(`⚠ ${task.id}: forEach source has ${sel.length} items — running the first ${items.length} (maxItems); raise maxItems to cover the rest`);
    }
    tasks.splice(tasks.indexOf(task) + 1, 0, ...clones);
    for (const c of clones) {
      state.set(c.id, "pending");
      if (!force) {
        const prior = readResult(plan.resultsDir, c.id);
        if (prior && prior.ok === true) record(c, "skipped", prior.durationMs ?? null, prior.tokens);
      }
    }
    task.when = undefined;
    task.forEach = undefined;
    task.childPlan = undefined; // the clones carry it; the parent is now pure aggregate
    task.after = clones.map((c) => c.id);
    task.aggregate = { truncated, kept: items.length, total: sel.length };
    rebuildGroups();
    paint();
  };

  // Splice a manifest node's child tasks into the run under `<node>~<local>`
  // ids, remapping within-child references; the node morphs into an aggregate
  // over the child's sinks (tasks with no within-child dependents).
  const expandManifest = (node) => {
    const locals = new Set(node.childPlan.tasks.map((c) => c.id));
    const remap = (id) => `${node.id}~${id}`;
    const hasItem = node.manifestItem !== undefined;
    // {{result:local}} / {{resultPath:local}} references to sibling child tasks are
    // rewritten to the spliced ids — in the prompt AND in each mustRead entry's
    // path/index string, so a verifier's `mustRead: ["{{resultPath:finder}}"]`
    // resolves to the remapped id at check time.
    const remapRefs = (s) => s.replace(TEMPLATE_RE, (whole, kind, id) => (locals.has(id) ? `{{${kind}:${remap(id)}}}` : whole));
    const remapMustRead = (entries) => entries.map((e) =>
      typeof e === "string" ? remapRefs(e)
      : e && typeof e === "object" ? {
          ...e,
          ...(typeof e.path === "string" && { path: remapRefs(e.path) }),
          ...(typeof e.index === "string" && { index: remapRefs(e.index) }),
        }
      : e);
    const spliced = node.childPlan.tasks.map((c) => {
      let prompt = remapRefs(c.prompt);
      // a child task with its own forEach keeps its {{item}} for its own clones
      if (hasItem && c.forEach === undefined) prompt = substituteItems(prompt, node.manifestItem, node.manifestIndex);
      return {
        ...c,
        id: remap(c.id),
        prompt,
        ...(Array.isArray(c.mustRead) && { mustRead: remapMustRead(c.mustRead) }),
        // Worktree names are remapped with the ids: two nodes splicing the same
        // child would otherwise resolve to one path, and an un-remapped name is
        // absent from the group maps entirely (never collected, never reset).
        ...(c.worktreeName !== undefined && { worktreeName: remap(c.worktreeName) }),
        after: c.after.map((d) => (locals.has(d) ? remap(d) : d)),
        ...(c.when && { when: { ...c.when, from: locals.has(c.when.from) ? remap(c.when.from) : c.when.from } }),
        ...(c.forEach && { forEach: { ...c.forEach, from: locals.has(c.forEach.from) ? remap(c.forEach.from) : c.forEach.from } }),
        ...(c.compute !== undefined && {
          depAliases: Object.fromEntries(c.after.map((d) => [d, locals.has(d) ? remap(d) : d])),
        }),
      };
    });
    appendRunLog(plan.resultsDir, {
      ts: new Date().toISOString(), event: "expand-manifest", id: node.id,
      ...durableIdentity(node),
      children: spliced.map((c) => ({ id: c.id, model: c.model, ...durableIdentity(c) })),
    });
    tasks.splice(tasks.indexOf(node) + 1, 0, ...spliced);
    for (const c of spliced) {
      state.set(c.id, "pending");
      if (!force) {
        const prior = readResult(plan.resultsDir, c.id);
        if (prior && prior.ok === true) record(c, "skipped", prior.durationMs ?? null, prior.tokens);
      }
    }
    const dependedOn = new Set(node.childPlan.tasks.flatMap((c) => c.after.filter((d) => locals.has(d))));
    const sinks = node.childPlan.tasks.filter((c) => !dependedOn.has(c.id)).map((c) => ({ local: c.id, full: remap(c.id) }));
    node.when = undefined;
    node.childPlan = undefined;
    node.after = spliced.map((c) => c.id);
    node.aggregateManifest = { sinks };
    rebuildGroups();
    paint();
  };

  const runManifestAggregate = (task) => {
    const outputJson = Object.fromEntries(task.aggregateManifest.sinks.map(({ local, full }) => [local, valueOf(full)]));
    const result = {
      id: task.id, model: task.model, ...durableIdentity(task), ok: true, exit: 0, durationMs: 0,
      output: JSON.stringify(outputJson), outputJson, children: task.after.length,
    };
    writeResult(plan.resultsDir, task.id, result);
    record(task, "ok", 0);
  };

  const runAggregate = (task) => {
    const outs = task.after.map((cid) => {
      const r = readResult(plan.resultsDir, cid);
      return r && r.outputJson !== undefined ? r.outputJson : String(r?.output ?? "");
    });
    const result = {
      id: task.id, model: task.model, ...durableIdentity(task), ok: true, exit: 0, durationMs: 0,
      output: JSON.stringify(outs), outputJson: outs,
      clones: task.after.length,
      ...(task.aggregate.truncated && { truncated: { kept: task.aggregate.kept, total: task.aggregate.total } }),
    };
    writeResult(plan.resultsDir, task.id, result);
    record(task, "ok", 0);
  };

  const launch = (task) => {
    record(task, "running");
    const promise = (async () => {
      // Ask mode: interrogate the recorded leaf in place. No worktree prepare,
      // no retry/fallback/digest — this is a single resumed dispatch, and the
      // leaf's own terminal state must never flip because the interrogation
      // itself failed (D8): the state recorded below is always "ok".
      if (ask && task.id === ask.taskId) {
        const prior = readResult(plan.resultsDir, task.id);
        // prior.model is what actually ran (post-fallback) and what askLeaf's
        // governance gate checked — task.model is only the manifest's ask.
        const model = ask.model || prior.model;
        const r = await runTask({
          ...task,
          cwd: prior.cwd,
          originalCwd: prior.originalCwd || task.originalCwd || prior.cwd,
          model,
          ...(ask.provider || task.provider || prior.provider ? { provider: ask.provider || task.provider || prior.provider } : {}),
          resume: prior.sessionId,
        }, ask.question, cfg, io, null, streamHooks(task), runtime);
        appendFileSync(join(plan.resultsDir, "results", `${task.id}.ask.log`), `Q: ${ask.question}\nA: ${r.output}\n\n`);
        const askEntry = {
          question: ask.question,
          answer: r.output,
          ok: r.ok,
          model,
          ...(r.provider && { provider: r.provider }),
          ...(r.runner && { runner: r.runner }),
          ...(tokenTotal(r.tokens) + (r.tokens?.cacheRead || 0) > 0 && { tokens: r.tokens }),
          ...(r.sessionId && { sessionId: r.sessionId }),
        };
        // The leaf's own identity is what it ran as; an override's identity lives on its ask entry.
        const updated = { ...prior, asks: [...(prior.asks || []), askEntry] };
        if (r.ok && r.sessionId) updated.sessionId = r.sessionId;
        writeResult(plan.resultsDir, task.id, updated);
        record(task, "ok", r.durationMs, r.tokens, r.ok ? undefined : `ask failed: ${r.output}`);
        return task.id;
      }
      if (task.outputDir) mkdirSync(task.outputDir, { recursive: true });
      // report mode drafts here; the prompt names it, so it must exist
      if (task.isDigest && plan.digest?.report) mkdirSync(digestScratchPath(plan.resultsDir), { recursive: true });

      // Resume a previously-failed leaf in place: re-enter its kept worktree
      // (partial diff intact) and resume its session, rather than starting cold.
      // --force is a deliberate fresh redo, so it resets the tree and drops the
      // session. A first-ever run has no prior and does neither. A leaf whose
      // engine died before it settled has no result, only its recorded session.
      const prior = force ? null : readResult(plan.resultsDir, task.id);
      const recorded = recordedSessions.get(task.id);
      const resumeId = prior?.ok === true ? null : (prior?.sessionId ?? recorded?.sessionId ?? null);
      const resumeProvider = task.provider || prior?.provider || recorded?.provider;

      let wt = null;
      let taskCwd = task.cwd;
      const wtName = nameOf(task);
      if (wtName !== undefined) {
        try {
          wt = worktree.prepareIsolation({ ...task, worktreeName: wtName }, cfg, plan.resultsDir, {
            reset: force && groupFirst.get(wtName) === task.id,
          });
          // Every tree-holding leaf sits at its declared depth. Unconditionally: the old
          // mode test skipped this for a hand-written tree and landed it at the root.
          taskCwd = defaultWorktree.treeCwd(wt.path, task.repoToplevel, task.originalCwd);
          if (wt.reused) appendRunLog(plan.resultsDir, {
            ts: new Date().toISOString(), event: "worktree-resume", id: task.id,
            reset: force, session: resumeId ? "resumed" : "fresh",
          });
        } catch (e) {
          const result = { id: task.id, model: task.model, ...durableIdentity(task), ok: false, exit: null, durationMs: 0, output: `worktree setup failed: ${e.message}` };
          writeResult(plan.resultsDir, task.id, result);
          record(task, "failed", 0);
          return task.id;
        }
      }

      let prompt = task.prompt;
      let promptTruncations = [];
      if (!task.promptFinal) {
        const sub = substituteTemplates(task.prompt, plan.resultsDir, cfg.resultInlineCap ?? 4000);
        prompt = sub.prompt;
        promptTruncations = sub.truncations;
        notePromptTruncations(task, promptTruncations);
      }
      // Resume appends: a resumed leaf's session holds every earlier Read, so its
      // transcript must too (coverage checks the whole attempt history). A fresh
      // run (or --force) truncates.
      const leafLog = createWriteStream(join(plan.resultsDir, "results", `${task.id}.log`), resumeId ? { flags: "a" } : {});
      let r = await runTask({
        ...task, cwd: taskCwd,
        ...(resumeId && { resume: resumeId }),
        ...(resumeProvider && { provider: resumeProvider }),
      }, prompt, cfg, io, leafLog, streamHooks(task), runtime);
      if ((task.returns || task.mustRead) && r.ok) {
        r = await enforceLeafContract(task, r, taskCwd, plan.resultsDir, cfg, io, streamHooks(task), runtime);
      }

      // Claude leaves record the REAL model id (from the init event) with the
      // manifest alias kept as modelAlias — grade rows resolve model from here.
      // Non-Claude models keep the manifest name verbatim: ':cloud' is a
      // routing/governance identity an init-reported bare name must not clobber.
      const stamped = r.realModel && isClaudeModel(task.model) && r.realModel !== task.model;
      const resultIdentity = task.provider !== undefined
        ? { provider: r.provider || resolvedIdentity(task).provider, runner: r.runner || providerRegistry.get(r.provider || resolvedIdentity(task).provider).runnerId }
        : {};
      const result = {
        id: task.id,
        model: stamped ? r.realModel : task.model,
        ...resultIdentity,
        ...(stamped && { modelAlias: task.model }),
        ok: r.ok,
        exit: r.exit,
        durationMs: r.durationMs,
        prompt, // the exact string sent — with the snapshot, the leaf's full intent
        output: r.output,
        // A drill-down straight to results/<id>.json must see that this leaf's
        // input was cut — the run-level warning is easy to skip past.
        ...(promptTruncations.length && { promptTruncations }),
      };
      if (tokenTotal(r.tokens) + (r.tokens?.cacheRead || 0) > 0) result.tokens = r.tokens;
      if (r.costUsd != null) result.costUsd = r.costUsd;
      if (r.numTurns != null) result.numTurns = r.numTurns;
      // interrogation fields: `swarm ask` resumes this session in this cwd;
      // originalCwd (pre worktree redirect) is the governance identity
      if (r.sessionId) result.sessionId = r.sessionId;
      if (r.schemaRetried) result.schemaRetried = true;
      if (r.schemaErrors) result.schemaErrors = r.schemaErrors;
      if (r.citations) result.citations = r.citations;
      // Refuted citations are KEPT and annotated, never a failure. Loud
      // per-leaf (in the result) and run-level (the closing block) — a kept-but-
      // unverified finding must read as exactly that, never as verified.
      if (r.citationRefuted?.length) {
        result.citationRefuted = r.citationRefuted;
        refutations.push({ id: task.id, refuted: r.citationRefuted.length, total: r.citations.checked + r.citations.refuted });
      }
      // Coverage rides the same rail as refutations: recorded on the result, and —
      // when short — pushed to the run-level list the closing block prints loud.
      if (r.coverage) {
        result.coverage = r.coverage;
        if (r.coverage.status !== "complete") coverageGaps.push({ id: task.id, ...r.coverage });
      }
      result.cwd = taskCwd;
      result.originalCwd = task.originalCwd;
      if (task.repoToplevel) result.repoToplevel = task.repoToplevel;
      result.allowedTools = task.allowedTools;

      // returns-validation failures are semantic — the leaf itself ran fine.
      // Never classify them by transcript grep: a stray "429" (line number,
      // token count) in the raw stream would misread them as transient.
      // A leaf the valve just killed produced no output text classifyFailure
      // could ever match — memoryStopped is set directly by the heartbeat, so
      // it is checked ahead of everything else, even a stray r.ok race. The
      // `!r.ok` guard covers the valve racing a leaf that had already exited
      // ok: pickNewestRunning excludes dead children, but the flag can still
      // be set from the same tick that kills a genuinely live one, so clear
      // it unconditionally here to avoid leaking a stale entry either way.
      const isMemoryStop = memoryStopped.has(task.id) && !r.ok;
      memoryStopped.delete(task.id);
      const st = isMemoryStop ? "memory"
        : r.ok ? "ok"
        : r.schemaErrors ? "failed"
        : classifyFailure({ timedOut: r.timedOut, output: r.raw, stopped: stopRequested }, cfg.quotaPatterns);
      if (isMemoryStop) {
        // runTask's generic mid-stream message tells a reader not to kill or
        // diff-hunt — exactly backwards here, where the kill was deliberate.
        result.output = result.output.replace(
          /leaf terminated mid-stream \(no (?:end_turn|terminal event)\)[^\n]*\n?/,
          "leaf stopped for low memory — parked; the engine resumes it automatically once memory recovers.\n",
        );
      }
      if (st === "quota") {
        const resetsAt = parseQuotaReset(r.raw);
        if (resetsAt) result.quotaResetsAt = resetsAt;
      }
      // A 402 extra-usage failure means the account can't run this model:
      // drop it from the models cache so the roster stops offering it. The
      // classification stays "failed" — entitlement is roster metadata, not a
      // retry class — and the next `models` refresh restores the row if the
      // probe stops 402ing.
      if (!r.ok && ENTITLEMENT_RE.test(r.raw || "")) removeCachedModel(task.model, io.env, task.provider);
      const parsed = tryParseJson(r.output);
      if (parsed !== undefined) result.outputJson = parsed;

      if (wt && groupFinal.get(wtName) === task.id) {
        const isChainFollower = (groupMembers.get(wtName)?.length ?? 1) > 1;
        const collected = worktree.collect(task, cfg, wt, {
          isChainFollower,
          isIntegrateSource: isIntegrateSourceId(task.id),
        });
        result.worktree = collected;
        if (collected.kept) worktreesKept.push({
          name: wt.name ?? wtName, branch: collected.branch,
          path: collected.path, diffstat: collected.diffstat,
          taskIds: groupMembers.get(wtName),
        });
      } else if (wt) {
        // Mid-chain link: record where it worked, leave the tree for its successor.
        result.worktree = { kept: true, branch: wt.branch, path: wt.path, name: wt.name, pending: true };
      }

      writeResult(plan.resultsDir, task.id, result);

      // D4/D5: land the valve's kill as a park, not a retry — it never
      // touches attempts, so it can never exhaust a leaf's retry budget.
      if (isMemoryStop) {
        parkForMemory(task);
        return task.id;
      }

      if (!r.ok) {
        const retry = cfg.retry || {};
        const n = attempts.get(task.id) || 0;
        // transient failures retry in-run with backoff; spawn errors (exit
        // null, not killed) get one immediate-ish retry for environment flakes
        if (st === "rate-limited" && n < (retry.rateLimited ?? 2)) {
          attempts.set(task.id, n + 1);
          const delay = (retry.backoffMs ?? 30000) * Math.pow(3, n);
          scheduleRetry(task, delay, `↻ retry ${n + 1}/${retry.rateLimited ?? 2} in ${Math.round(delay / 1000)}s`);
          return task.id;
        }
        // ENAMETOOLONG is a deterministic argv-size failure (win32 command-line
        // cap) — retrying it burns a slot on a leaf that will fail identically.
        if (st === "failed" && r.exit === null && !r.timedOut && r.errorCode !== "ENAMETOOLONG" && n < (retry.spawnError ?? 1)) {
          attempts.set(task.id, n + 1);
          scheduleRetry(task, 2000, "↻ retry after spawn error");
          return task.id;
        }
        // quota (immediately) or exhausted rate-limit retries: one switch to
        // the manifest-declared fallback — the engine never substitutes a
        // model the user didn't approve
        if ((st === "quota" || st === "rate-limited") && task.fallbackModel && !usedFallback.has(task.id)) {
          usedFallback.add(task.id);
          const from = { provider: r.provider || resolvedIdentity(task).provider, model: task.model };
          const target = {
            model: task.fallbackModel,
            ...(task.fallbackProvider !== undefined && { provider: task.fallbackProvider }),
          };
          let next, rejected;
          try {
            next = resolvedIdentity(target);
            const problems = providerRegistry.get(next.provider).validateTask({ ...task, ...next }, { config: cfg, task });
            if (problems?.length) rejected = problems.join("; ");
          } catch (e) {
            rejected = e.message;
          }
          // A rejected fallback ends only this leaf, in its real quota state; the run carries on.
          if (rejected) {
            appendRunLog(plan.resultsDir, {
              ts: new Date().toISOString(), id: task.id, event: "fallback-rejected",
              fromProvider: from.provider, toProvider: next?.provider ?? target.provider, toModel: target.model, reason: rejected,
            });
          } else {
            appendRunLog(plan.resultsDir, {
              ts: new Date().toISOString(), id: task.id, event: "fallback",
              from: from.model, to: next.model,
              fromProvider: from.provider, toProvider: next.provider,
              fromModel: from.model, toModel: next.model,
            });
            task.model = next.model;
            task.provider = next.provider;
            attempts.set(task.id, 0);
            scheduleRetry(task, 10, `↯ fallback → ${task.provider}/${task.model}`);
            return task.id;
          }
        }
        // terminal quota: pre-emptively fail-fast every still-pending leaf in
        // the same provider/applicable limit scope without a fallback — one
        // failure, one lesson. Unrelated providers continue independently.
        if (st === "quota") {
          const current = resolvedIdentity(task);
          const familyOf = (model) => String(model || "").match(/(fable|opus|sonnet|haiku)/i)?.[1]?.toLowerCase() || "";
          // A mid-run transcript without a named family is a provider-wide
          // quota bucket; a transcript that names one family stays scoped.
          const quotaFamily = familyOf(r.raw);
          for (const t of tasks) {
            if (isAgentless(t) || state.get(t.id) !== "pending" || t.fallbackModel) continue;
            const candidate = resolvedIdentity(t);
            const sameScope = candidate.provider === current.provider && (
              current.provider !== "claude" || !quotaFamily || quotaFamily === familyOf(t.model)
            );
            if (sameScope) {
              record(t, "quota");
            }
          }
        }
      }

      if (task.isDigest) {
        if (r.ok) digestPath = writeDigestMd(plan.resultsDir, r.output);
        else digestFailed = true;
      }

      record(task, st, r.durationMs, r.tokens);

      // Projection warn: this leaf is terminal (retry/fallback paths returned
      // above). Track spend, project over the worst-case remainder, warn once.
      const realKey = r.apiKeySource != null && r.apiKeySource !== "none";
      if (r.costUsd != null && realKey) costMap.set(task.id, r.costUsd);
      completedLeaves++;
      spentTokens += tokenTotal(r.tokens || emptyTokens());
      spentUsd += r.costUsd ?? 0;
      costIsRealComplete &&= r.costUsd != null && realKey;
      if (cfg.costWarn !== false && !costWarnFired) {
        const remaining = tasks.reduce((n, t) => {
          if (isAgentless(t) || t.aggregate || t.aggregateManifest || !ALIVE_STATES.has(state.get(t.id))) return n;
          const mult = t.forEach ? t.forEach.maxItems : 1;
          if (t.childPlan) return n + mult * t.childPlan.tasks.filter((c) => !isAgentless(c)).length;
          return n + mult;
        }, 0);
        const useUsd = costIsRealComplete && spentUsd > 0;
        const threshold = useUsd ? (cfg.costWarnUsd ?? 10) : (cfg.costWarnTokens ?? 5_000_000);
        const projected = projectRun({ spent: useUsd ? spentUsd : spentTokens, completed: completedLeaves, remaining });
        if (projected != null && projected >= threshold) {
          costWarnFired = true;
          const fmt = useUsd ? (n) => `$${n.toFixed(2)}` : (n) => `${formatTokens(n)} tokens`;
          const text = `⚠ projected ~${fmt(projected)} for this run (threshold ${fmt(threshold)}) — ${completedLeaves}/${completedLeaves + remaining} leaves done`;
          io.stdout(text);
          appendRunLog(plan.resultsDir, { ts: new Date().toISOString(), event: "cost-warn", unit: useUsd ? "usd" : "tokens", projected, threshold });
          io.notify?.(text);
        }
      }
      return task.id;
    })().finally(() => { running.delete(task.id); children.delete(task.id); });
    running.set(task.id, promise);
  };

  for (;;) {
    // Block anything whose dependency chain is doomed (fail/timeout/rate-limit/
    // blocked). Independent branches keep going.
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of tasks) {
        if (state.get(t.id) === "pending" && depsDoomed(t)) {
          record(t, "blocked");
          changed = true;
        }
      }
    }

    // Inline settles (when-skip, compute, expansion, aggregation) change state
    // without occupying a slot — after any of them, re-drive the whole cycle so
    // tasks earlier in the array unlock in the same pass.
    let progressed = false;
    if (!stopRequested) {
      for (const t of tasks) {
        if (running.size >= plan.concurrency) break;
        if (state.get(t.id) !== "pending" || !depsSatisfied(t)) continue;
        if (!passesWhen(t)) { progressed = true; continue; }
        if (t.forEach) { expandForEach(t); progressed = true; continue; }
        if (t.childPlan) { expandManifest(t); progressed = true; continue; }
        if (t.aggregate) { runAggregate(t); progressed = true; continue; }
        if (t.aggregateManifest) { runManifestAggregate(t); progressed = true; continue; }
        if (t.compute) { runCompute(t); progressed = true; continue; }
        if (t.integrate) { runIntegrate(t); progressed = true; continue; }
        // Spawn floor (D3): only once something is already running — the very
        // first leaf of a run must never be gated by the machine's headroom.
        if (running.size > 0 && memLow(cfg.minFreeMemMb)) { parkForMemory(t); continue; }
        launch(t);
      }
    }
    if (progressed) continue;

    // Stop wins: whatever is parked or waiting gets swept to failed:stopped below.
    if (running.size === 0 && (stopRequested || (memoryParked.size === 0 && retryWaiting === 0))) break;
    if (running.size > 0) {
      await Promise.race(running.values());
      // running is keyed by id and released on settlement; state is the truth about
      // what is alive. They can only disagree if a slot was stranded — which silently
      // narrows every later pass, so say so rather than degrading quietly.
      const live = [...running.keys()].filter((id) => ALIVE_STATES.has(state.get(id)));
      if (live.length !== running.size) {
        appendRunLog(plan.resultsDir, {
          ts: new Date().toISOString(), event: "slot-leak",
          held: running.size, live: live.length,
          stranded: [...running.keys()].filter((id) => !ALIVE_STATES.has(state.get(id))),
        });
      }
    } else {
      // nothing running, but leaves are sleeping out a backoff — idle until
      // the next retry timer re-arms one as pending
      await new Promise((resolve) => { wake = resolve; });
      wake = () => {};
    }
  }
  // A leaf that never got a slot (still pending) or was mid-backoff never runs
  // classifyFailure's stopped branch — say so here, or a stopped run leaves it
  // reading "pending" forever, indistinguishable from a run that just hasn't
  // started it yet.
  if (stopRequested) {
    for (const t of tasks) {
      if (state.get(t.id) === "pending" || state.get(t.id) === "retrying") record(t, "failed:stopped", 0);
    }
  }
  } finally {
    clearInterval(heartbeat);
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigtermHandler);
  }

  // Ask mode changes exactly one row of a run the engine already finished: the
  // interrogated leaf gains duration/tokens from the ask on top of its prior
  // totals; every other row, and worktreesKept (nothing here re-collects a
  // tree), is carried over byte-verbatim from that finished run's summary.json.
  let summary;
  if (ask) {
    const priorSummary = readSummary(plan.resultsDir) ?? { started, tasks: [], worktreesKept: [] };
    const priorRow = priorSummary.tasks.find((t) => t.id === ask.taskId);
    const askedTask = tasks.find((t) => t.id === ask.taskId);
    const askedRow = {
      ...(priorRow ?? { id: ask.taskId, model: askedTask?.model, resultPath: resultPath(plan.resultsDir, ask.taskId) }),
      ...(askedTask ? durableIdentity(askedTask) : {}),
      state: "ok",
      durationMs: (priorRow?.durationMs ?? 0) + (durations.get(ask.taskId) ?? 0),
      tokens: addTokens(priorRow?.tokens ?? emptyTokens(), tokensMap.get(ask.taskId) ?? emptyTokens()),
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
      started,
      finished: new Date().toISOString(),
      ...(stopRequested && { stopped: true, stopReason }),
      tasks: tasks.map((t) => ({
        id: t.id,
        // model + costUsd feed the estimate corpus (src/estimate.mjs loadCorpus)
        model: t.model,
        ...durableIdentity(t),
        state: state.get(t.id),
        durationMs: durations.get(t.id) ?? null,
        tokens: tokensMap.get(t.id) ?? null,
        ...(costMap.has(t.id) && { costUsd: costMap.get(t.id) }),
        resultPath: resultPath(plan.resultsDir, t.id),
      })),
      blocked: tasks.filter((t) => state.get(t.id) === "blocked").map((t) => t.id),
      worktreesKept,
      totalTokens: [...tokensMap.values()].reduce(addTokens, emptyTokens()),
      ...(truncations.length && { truncations }),
      ...(refutations.length && { refutations }),
      ...(coverageGaps.length && { coverageGaps }),
      ...(plan.estimate !== undefined && { estimate: plan.estimate }),
      ...(costWarnFired && { costWarnFired: true }),
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
          truncations,
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

  return { summary, summaryPath, digestPath, digestFailed, reportPath, reportMissing, worktreesKept, memoryParks: memoryParkCount };
}
