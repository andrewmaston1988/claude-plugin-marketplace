import { mkdirSync, createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { buildDispatch, toSpawnable } from "./dispatch.mjs";
import { isClaudeModel } from "./models.mjs";
import { buildDigestTask, DIGEST_ID, reportPath as digestReportPath } from "./digest.mjs";
import { effectivePlanDoc } from "./manifest.mjs";
import {
  initResultsDir, resultPath, writeResult, readResult, writeSummary,
  writeManifestSnapshot, writeDigestMd, appendRunLog, renderRoster, formatTokens,
  renderProvenance,
} from "./results.mjs";
import { projectRun, formatEstimate } from "./estimate.mjs";
import {
  createStreamParser, createUsageAccumulator, pickFinalTokens,
  addTokens, emptyTokens, tokenTotal,
} from "./stream.mjs";
import { createSnapshotWriter } from "./ui.mjs";
import { matchQuota, parseQuotaReset, checkQuota, DEFAULT_QUOTA_PATTERNS } from "./quota.mjs";
import { evalExpr, evalBool } from "./expr.mjs";
import { validateValue } from "./schema.mjs";
import { extractCitations, verifyCitations, citationErrorLines } from "./citations.mjs";
import { swarmHome } from "./config.mjs";
import * as defaultWorktree from "./worktree.mjs";

const RATE_LIMIT_RE = /rate.?limit|429|too many requests/i;
const OK_STATES = new Set(["ok", "skipped"]);
// Non-terminal, non-doomed: a leaf waiting out a backoff or model fallback.
const ALIVE_STATES = new Set(["pending", "running", "retrying"]);
const TEMPLATE_RE = /\{\{(result|resultPath):([^}]*)\}\}/g;

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
    stdout: (line) => process.stdout.write(line + "\n"),
    snapshot: createSnapshotWriter(),
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
export function classifyFailure({ timedOut, output }, quotaPatterns = DEFAULT_QUOTA_PATTERNS) {
  if (timedOut) return "failed:timeout";
  if (matchQuota(output, quotaPatterns)) return "quota";
  if (RATE_LIMIT_RE.test(output || "")) return "rate-limited";
  return "failed";
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

// Enforce a task's `returns` schema on a completed leaf. Valid output passes
// through untouched. Invalid output gets exactly ONE corrective turn through
// the leaf's own resumed session (the `ask` pattern — the leaf still holds its
// reads and reasoning, so the fix costs one turn, not a re-run); still-invalid
// output fails the task with the validator's teaching errors. Runs before
// worktree collection so the corrective turn executes in the leaf's real cwd.
async function enforceReturns(task, r, taskCwd, resultsDir, cfg, io, hooks) {
  // Schema first; when the shape holds, mechanically verify any citation-shaped
  // instances (N3) against the leaf's cwd. kind routes the fail field
  // (schemaErrors vs citationErrors); cite carries the verification stats.
  const assess = (output) => {
    const parsed = tryParseJson(output);
    if (parsed === undefined) {
      return { errs: ["output is not JSON — reply with a single JSON value matching the schema"], kind: "schema" };
    }
    const schemaErrs = validateValue(parsed, task.returns);
    if (schemaErrs.length) return { errs: schemaErrs, kind: "schema" };
    if (task.verifyCitations === false) return { errs: [] };
    const cits = extractCitations(parsed, task.returns);
    if (!cits.length) return { errs: [] };
    const cite = verifyCitations(cits, { cwds: [taskCwd, task.originalCwd] });
    return { errs: cite.refuted.length ? citationErrorLines(cite.refuted) : [], kind: "citations", cite };
  };
  const failText = (errs) => `returns validation failed:\n  - ${errs.join("\n  - ")}`;
  const logCitations = (cite) => appendRunLog(resultsDir, {
    ts: new Date().toISOString(), event: "citations", id: task.id,
    checked: cite.checked, refuted: cite.refuted.length,
  });
  const finish = (res, a) => {
    if (!a.cite) return res;
    logCitations(a.cite);
    return { ...res, citations: { checked: a.cite.checked, drifted: a.cite.drifted.length } };
  };
  const fail = (res, a, suffix = "") => {
    if (a.cite) logCitations(a.cite);
    const failed = { ...res, ok: false, output: failText(a.errs) + suffix };
    failed[a.kind === "citations" ? "citationErrors" : "schemaErrors"] = a.errs;
    return failed;
  };

  const a1 = assess(r.output);
  if (!a1.errs.length) return finish(r, a1);
  if (!r.sessionId) return fail(r, a1, "\n(no session id — re-ask unavailable)");

  appendRunLog(resultsDir, { ts: new Date().toISOString(), event: "schema-retry", id: task.id });
  // Schema misses carry the schema itself, not just the errors — the original
  // prompt may have underspecified the shape, and "expected object" alone
  // doesn't name fields. Citation refutations already name file/line/fix.
  const retryPrompt = a1.kind === "schema"
    ? `Your output did not match the task's returns schema:\n  - ${a1.errs.join("\n  - ")}\n` +
      `The required schema is:\n${JSON.stringify(task.returns, null, 2)}\n` +
      `Reply with ONLY the corrected JSON — no prose, no fences.`
    : `Some citations in your output could not be verified against the actual files:\n  - ${a1.errs.join("\n  - ")}\n` +
      `Reply with ONLY the corrected JSON — no prose, no fences.`;
  const leafLog = createWriteStream(join(resultsDir, "results", `${task.id}.log`), { flags: "a" });
  const r2 = await runTask({ ...task, cwd: taskCwd, resume: r.sessionId }, retryPrompt, cfg, io, leafLog, hooks);

  const combined = {
    ...r,
    durationMs: r.durationMs + r2.durationMs,
    tokens: addTokens(r.tokens || emptyTokens(), r2.tokens || emptyTokens()),
    ...((r.costUsd != null || r2.costUsd != null) && { costUsd: (r.costUsd || 0) + (r2.costUsd || 0) }),
    sessionId: r2.sessionId ?? r.sessionId,
    schemaRetried: true,
  };
  const a2 = r2.ok
    ? assess(r2.output)
    : { errs: [`re-ask failed (exit ${r2.exit}): ${r2.output.slice(0, 200)}`], kind: "schema" };
  if (!a2.errs.length) return finish({ ...combined, ok: true, output: r2.output }, a2);
  return fail(combined, a2);
}

// Exported for src/ask.mjs — interrogation reuses the exact dispatch path.
export function runTask(task, prompt, cfg, io, leafLog, { onTokens, onActivity } = {}) {
  return new Promise((resolve) => {
    const { argv, env } = buildDispatch(task, prompt, cfg);
    const started = io.now();
    let child;
    try {
      child = io.spawn(argv[0], argv.slice(1), {
        cwd: task.cwd,
        env: { ...(io.env || process.env), ...env },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      // same contract as settle(): the log is durable before the task resolves
      const done = () => resolve({ ok: false, exit: null, durationMs: 0, output: `spawn error: ${e.message}`, raw: "", timedOut: false, tokens: emptyTokens() });
      if (leafLog) leafLog.end(`spawn error: ${e.message}\n`, done);
      else done();
      return;
    }
    let raw = "";
    let timedOut = false;
    let settled = false;
    // stream-json events on stdout: per-turn usage feeds the live token count,
    // the result event carries the final text + authoritative usage. Anything
    // non-JSONL (old CLI, plain-text provider) leaves both empty and the raw
    // buffer stands in as the output — same behavior as before stream-json.
    const acc = createUsageAccumulator();
    let resultEvt = null;
    let initEvt = null;
    const parser = createStreamParser({
      onUsage: (id, usage) => { acc.record(id, usage); onTokens?.(acc.totals()); },
      onResult: (evt) => { resultEvt = evt; },
      onInit: (evt) => { initEvt = evt; },
      onActivity,
    });
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

    const settle = (exit, errMsg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parser.end();
      if (errMsg) raw += (raw ? "\n" : "") + errMsg;
      flushLog().then(() => resolve({
        ok: exit === 0 && !timedOut && !(resultEvt?.is_error),
        exit,
        durationMs: io.now() - started,
        output: resultEvt?.result != null ? String(resultEvt.result) : String(raw),
        raw: String(raw),
        timedOut,
        tokens: pickFinalTokens(resultEvt?.usage, acc.totals()),
        costUsd: resultEvt?.total_cost_usd,
        numTurns: resultEvt?.num_turns,
        sessionId: initEvt?.session_id ?? resultEvt?.session_id ?? null,
        // "none" on subscription auth — costUsd is synthetic there, real only
        // when a key source is named (unit honesty for estimates and warns)
        apiKeySource: initEvt?.apiKeySource ?? null,
      }));
    };
    child.on("error", (e) => settle(null, `spawn error: ${e.message}`));
    child.on("close", (code) => settle(code));
  });
}

// Execute the plan's dependency graph under the concurrency cap.
// Returns { summary, summaryPath, digestPath, digestFailed, worktreesKept }.
export async function runPlan(plan, cfg, io = makeDefaultIo(), { force = false } = {}) {
  const worktree = io.worktree || defaultWorktree;
  const tasks = [...plan.tasks];
  if (plan.digest) tasks.push(buildDigestTask(plan));
  initResultsDir(plan.resultsDir);
  // P1: the run records its own intent — the effective plan persists beside
  // the outcomes it produced, so the corpus can answer "what was asked".
  writeManifestSnapshot(plan.resultsDir, effectivePlanDoc(plan));

  // Health check, once per run, only when any open-model task exists: any
  // response from the provider endpoint counts as up; fail the run fast with
  // a clear message when it is unreachable.
  // Preflights must see composed leaves too — a manifest node's children are
  // known statically even though they splice in at run time.
  const leafView = tasks.flatMap((t) => (t.childPlan ? t.childPlan.tasks : [t]));
  if (leafView.some((t) => !t.compute && t.model !== "manifest" && !isClaudeModel(t.model))) {
    try {
      await io.fetch(cfg.provider.url);
    } catch (e) {
      throw new Error(
        `provider endpoint ${cfg.provider.url} is unreachable (${e.message}) — ` +
        `open-model tasks cannot dispatch. Is the provider running?`
      );
    }
  }

  // Quota preflight, once per run, only when any Claude-model task exists.
  // Best-effort (endpoint failure -> proceed silently; the mid-run 'quota'
  // classification is the backstop). Exhausted quota with undefended Claude
  // leaves aborts BEFORE dispatch — a run that would deterministically fail
  // should fail in one second with the reset time, not after four minutes.
  const claudeTasks = leafView.filter((t) => !t.compute && isClaudeModel(t.model));
  if (claudeTasks.length && cfg.quotaPreflight !== false) {
    const env = io.env || process.env;
    const q = await checkQuota({
      cfg,
      fetch: io.fetch,
      now: io.now,
      cachePath: join(swarmHome(env), "quota-cache.json"),
      ...(env.SWARM_CREDENTIALS && { credentialsPath: env.SWARM_CREDENTIALS }),
    });
    // A scoped limit grounds only the model it names — never the whole roster.
    // Match on the family token, because the two sides are written differently:
    // a leaf says "sonnet" or "claude-sonnet-5"; the endpoint may say "Sonnet"
    // OR "Claude Sonnet 4.5". A bare substring test in one direction misses the
    // multi-word form and would let an exhausted Sonnet bucket dispatch Sonnet.
    const FAMILY_RE = /(fable|opus|sonnet|haiku)/i;
    const familyOf = (s) => (String(s || "").match(FAMILY_RE)?.[1] || "").toLowerCase();
    const blockedScope = (model) =>
      (q?.exhaustedScopes || []).find((s) => {
        const mf = familyOf(model), sf = familyOf(s.scope);
        if (mf && sf) return mf === sf;
        // Scope names a model we don't recognise: fall back to a two-way substring
        // test so an unclassifiable exhausted bucket still grounds a leaf naming it.
        const m = String(model).toLowerCase(), sc = String(s.scope || "").toLowerCase();
        return Boolean(sc) && (m.includes(sc) || sc.includes(m));
      });
    if (q?.exhausted || q?.exhaustedScopes?.length) {
      const doomed = claudeTasks.filter(
        (t) => !t.fallbackModel && (q.exhausted || blockedScope(t.model))
      );
      if (doomed.length) {
        const hit = q.exhausted ? q.worst : blockedScope(doomed[0].model);
        const what = q.exhausted
          ? `${hit.kind} at ${hit.percent}%`
          : `the ${hit.scope}-scoped limit is at ${hit.percent}%`;
        throw new Error(
          `Anthropic usage exhausted (${what}` +
          `${hit.resetsAt ? `, resets ${hit.resetsAt}` : ""}) — ` +
          `${doomed.length} Claude leaf(s) cannot dispatch: ${doomed.map((t) => t.id).join(", ")}. ` +
          `Recast to :cloud models, add fallbackModel, or re-run after reset.`
        );
      }
    }
    if (q && !q.exhausted && q.worst.percent >= (cfg.quotaWarnPct ?? 80)) {
      io.stdout(
        `⚠ Anthropic usage at ${q.worst.percent}% (${q.worst.kind}` +
        `${q.worst.resetsAt ? `, resets ${q.worst.resetsAt}` : ""}) — Claude leaves may hit quota mid-run`
      );
    }
  }

  // The approval-surface estimate (computed by the CLI) echoes at run start so
  // the consent line and the closing actual sit in the same transcript.
  if (plan.estimate !== undefined) io.stdout(formatEstimate(plan.estimate));

  const started = new Date().toISOString();
  // run-start line lets `status` derive pending tasks (ids never seen since
  // the latest run-start are pending) and carries models for the roster view.
  appendRunLog(plan.resultsDir, { ts: started, event: "run-start", tasks: tasks.map((t) => ({ id: t.id, model: t.model })) });
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
  let wake = () => {};            // resolves the loop's idle wait when a retry re-arms
  const worktreesKept = [];
  let digestPath = null;
  let digestFailed = false;

  let lastPaintMs = 0;
  const paint = (force = true) => {
    if (!io.snapshot) return;
    if (!force && io.now() - lastPaintMs < 1000) return; // token ticks repaint at most 1/s
    lastPaintMs = io.now();
    io.snapshot(renderRoster({
      title: basename(plan.resultsDir),
      tasks: tasks.map((t) => ({
        id: t.id, model: t.model, state: state.get(t.id),
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
    }));
  };

  const record = (task, st, durationMs, tokens, note) => {
    state.set(task.id, st);
    if (st === "running") startedAt.set(task.id, io.now());
    if (durationMs != null) durations.set(task.id, durationMs);
    if (tokens && tokenTotal(tokens) + tokens.cacheRead > 0) tokensMap.set(task.id, tokens);
    appendRunLog(plan.resultsDir, {
      ts: new Date().toISOString(), id: task.id, state: st,
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
    onTokens: (totals) => {
      tokensMap.set(task.id, totals);
      lastEventAt.set(task.id, io.now());
      appendRunLog(plan.resultsDir, { ts: new Date().toISOString(), id: task.id, event: "tokens", tokens: totals });
      paint(false);
    },
    onActivity: (desc) => {
      activityMap.set(task.id, desc);
      lastEventAt.set(task.id, io.now());
      if (io.now() - (lastActivityLogAt.get(task.id) ?? 0) >= 2000) {
        lastActivityLogAt.set(task.id, io.now());
        appendRunLog(plan.resultsDir, { ts: new Date().toISOString(), id: task.id, event: "activity", activity: desc });
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
  if (!force) {
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

  const running = new Map(); // id -> promise resolving to task id

  // Heartbeat: repaint while anything runs so elapsed and live tokens tick
  // even between state changes. unref'd — never holds the process open.
  const heartbeatMs = Math.max(50, (cfg.heartbeatSecs ?? 15) * 1000);
  const heartbeat = setInterval(() => { if (running.size > 0) paint(); }, heartbeatMs);
  if (heartbeat.unref) heartbeat.unref();

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
  const truncations = [];

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
      writeResult(plan.resultsDir, task.id, { id: task.id, model: task.model, ok: false, exit: null, durationMs: 0, output: `when failed: ${e.message}` });
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
        id: task.id, model: task.model, ok: true, exit: 0, durationMs: io.now() - t0,
        output: typeof v === "string" ? v : JSON.stringify(v),
        outputJson: v,
      };
    } catch (e) {
      result = { id: task.id, model: task.model, ok: false, exit: null, durationMs: io.now() - t0, output: `compute failed: ${e.message}` };
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
        id: task.id, model: task.model, ok: false, exit: null, durationMs: 0,
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
      ...(task.childPlan
        ? { manifestItem: item, manifestIndex: i }
        : { prompt: substituteItems(base, item, i), promptFinal: true }),
      when: undefined,
      forEach: undefined,
      after: [...task.after],
    }));
    appendRunLog(plan.resultsDir, {
      ts: new Date().toISOString(), event: "expand", id: task.id, model: task.model,
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
    paint();
  };

  // Splice a manifest node's child tasks into the run under `<node>~<local>`
  // ids, remapping within-child references; the node morphs into an aggregate
  // over the child's sinks (tasks with no within-child dependents).
  const expandManifest = (node) => {
    const locals = new Set(node.childPlan.tasks.map((c) => c.id));
    const remap = (id) => `${node.id}~${id}`;
    const hasItem = node.manifestItem !== undefined;
    const spliced = node.childPlan.tasks.map((c) => {
      let prompt = c.prompt.replace(TEMPLATE_RE, (whole, kind, id) => (locals.has(id) ? `{{${kind}:${remap(id)}}}` : whole));
      // a child task with its own forEach keeps its {{item}} for its own clones
      if (hasItem && c.forEach === undefined) prompt = substituteItems(prompt, node.manifestItem, node.manifestIndex);
      return {
        ...c,
        id: remap(c.id),
        prompt,
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
      children: spliced.map((c) => ({ id: c.id, model: c.model })),
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
    paint();
  };

  const runManifestAggregate = (task) => {
    const outputJson = Object.fromEntries(task.aggregateManifest.sinks.map(({ local, full }) => [local, valueOf(full)]));
    const result = {
      id: task.id, model: task.model, ok: true, exit: 0, durationMs: 0,
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
      id: task.id, model: task.model, ok: true, exit: 0, durationMs: 0,
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
      if (task.scratchRedirect) mkdirSync(task.cwd, { recursive: true });
      if (task.outputDir) mkdirSync(task.outputDir, { recursive: true });

      let wt = null;
      let taskCwd = task.cwd;
      if (task.isolation === "worktree") {
        try {
          wt = worktree.prepareIsolation(task, cfg, plan.resultsDir);
          taskCwd = wt.path;
        } catch (e) {
          const result = { id: task.id, model: task.model, ok: false, exit: null, durationMs: 0, output: `worktree setup failed: ${e.message}` };
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
      const leafLog = createWriteStream(join(plan.resultsDir, "results", `${task.id}.log`));
      let r = await runTask({ ...task, cwd: taskCwd }, prompt, cfg, io, leafLog, streamHooks(task));
      if (task.returns && r.ok) {
        r = await enforceReturns(task, r, taskCwd, plan.resultsDir, cfg, io, streamHooks(task));
      }

      const result = {
        id: task.id,
        model: task.model,
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
      // originalCwd (pre scratch/worktree redirect) is the governance identity
      if (r.sessionId) result.sessionId = r.sessionId;
      if (r.schemaRetried) result.schemaRetried = true;
      if (r.schemaErrors) result.schemaErrors = r.schemaErrors;
      if (r.citations) result.citations = r.citations;
      if (r.citationErrors) result.citationErrors = r.citationErrors;
      result.cwd = taskCwd;
      result.originalCwd = task.originalCwd;
      result.allowedTools = task.allowedTools;

      // returns-validation failures are semantic — the leaf itself ran fine.
      // Never classify them by transcript grep: a stray "429" (line number,
      // token count) in the raw stream would misread them as transient.
      const st = r.ok ? "ok"
        : (r.schemaErrors || r.citationErrors) ? "failed"
        : classifyFailure({ timedOut: r.timedOut, output: r.raw }, cfg.quotaPatterns);
      if (st === "quota") {
        const resetsAt = parseQuotaReset(r.raw);
        if (resetsAt) result.quotaResetsAt = resetsAt;
      }
      const parsed = tryParseJson(r.output);
      if (parsed !== undefined) result.outputJson = parsed;

      if (wt) {
        const collected = worktree.collect(task, cfg, wt);
        result.worktree = collected;
        if (collected.kept) worktreesKept.push({ id: task.id, branch: collected.branch, path: collected.path, diffstat: collected.diffstat });
      }

      writeResult(plan.resultsDir, task.id, result);

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
        if (st === "failed" && r.exit === null && !r.timedOut && n < (retry.spawnError ?? 1)) {
          attempts.set(task.id, n + 1);
          scheduleRetry(task, 2000, "↻ retry after spawn error");
          return task.id;
        }
        // quota (immediately) or exhausted rate-limit retries: one switch to
        // the manifest-declared fallback — the engine never substitutes a
        // model the user didn't approve
        if ((st === "quota" || st === "rate-limited") && task.fallbackModel && !usedFallback.has(task.id)) {
          usedFallback.add(task.id);
          appendRunLog(plan.resultsDir, { ts: new Date().toISOString(), id: task.id, event: "fallback", from: task.model, to: task.fallbackModel });
          task.model = task.fallbackModel;
          attempts.set(task.id, 0);
          scheduleRetry(task, 10, `↯ fallback → ${task.model}`);
          return task.id;
        }
        // terminal quota: pre-emptively fail-fast every still-pending leaf in
        // the same model family without a fallback — one failure, one lesson
        if (st === "quota") {
          const family = isClaudeModel(task.model);
          for (const t of tasks) {
            if (!t.compute && state.get(t.id) === "pending" && isClaudeModel(t.model) === family && !t.fallbackModel) {
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
          if (t.compute || t.aggregate || t.aggregateManifest || !ALIVE_STATES.has(state.get(t.id))) return n;
          const mult = t.forEach ? t.forEach.maxItems : 1;
          if (t.childPlan) return n + mult * t.childPlan.tasks.filter((c) => c.compute === undefined).length;
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
    })();
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
    for (const t of tasks) {
      if (running.size >= plan.concurrency) break;
      if (state.get(t.id) !== "pending" || !depsSatisfied(t)) continue;
      if (!passesWhen(t)) { progressed = true; continue; }
      if (t.forEach) { expandForEach(t); progressed = true; continue; }
      if (t.childPlan) { expandManifest(t); progressed = true; continue; }
      if (t.aggregate) { runAggregate(t); progressed = true; continue; }
      if (t.aggregateManifest) { runManifestAggregate(t); progressed = true; continue; }
      if (t.compute) { runCompute(t); progressed = true; continue; }
      launch(t);
    }
    if (progressed) continue;

    if (running.size === 0 && retryWaiting === 0) break;
    if (running.size > 0) {
      const finished = await Promise.race(running.values());
      running.delete(finished);
    } else {
      // nothing running, but leaves are sleeping out a backoff — idle until
      // the next retry timer re-arms one as pending
      await new Promise((resolve) => { wake = resolve; });
      wake = () => {};
    }
  }
  clearInterval(heartbeat);

  const summary = {
    started,
    finished: new Date().toISOString(),
    tasks: tasks.map((t) => ({
      id: t.id,
      // model + costUsd feed the estimate corpus (src/estimate.mjs loadCorpus)
      model: t.model,
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
    ...(plan.estimate !== undefined && { estimate: plan.estimate }),
    ...(costWarnFired && { costWarnFired: true }),
  };
  const summaryPath = writeSummary(plan.resultsDir, summary);

  // Report mode: the leaf wrote the body; the engine owns the header. Prepending
  // happens here because this is the first point where every leaf's final row and
  // the full truncation list are in hand — and the digest, being the terminal
  // node, has already finished.
  //
  // The whole block is best-effort BY CONTRACT: the agent path (digest.md) is
  // load-bearing, the human path is not. A report that fails to materialise must
  // never take the digest down with it.
  let reportPath = null;
  if (plan.digest?.report) {
    try {
      const p = digestReportPath(plan.resultsDir);
      if (existsSync(p)) {
        const body = readFileSync(p, "utf8");
        const header = renderProvenance({
          goal: plan.goal,
          tasks: summary.tasks.filter((t) => t.id !== DIGEST_ID),
          truncations,
        });
        writeFileSync(p, `${header}\n${body.trimStart()}`);
        reportPath = p;
      }
    } catch {
      reportPath = null; // a broken report is a missing report, never a broken run
    }
  }

  return { summary, summaryPath, digestPath, digestFailed, reportPath, worktreesKept };
}
