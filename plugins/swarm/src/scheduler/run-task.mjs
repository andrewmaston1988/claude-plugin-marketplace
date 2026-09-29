// The engine's top-level leaf primitives: default io, the two template passes,
// failure classification, the stop valve's pick, and the one dispatch path.
import { freemem } from "node:os";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { toSpawnable, buildDispatch } from "../dispatch.mjs";
import { strictSchema } from "../native-schema.mjs";
import { resultPath, readResult } from "../results.mjs";
import { createRunnerParser, emptyTokens } from "../stream.mjs";
import { createSnapshotWriter, liveViewLines } from "../ui.mjs";
import { TEMPLATE_RE } from "../coverage.mjs";
import { matchQuota, DEFAULT_QUOTA_PATTERNS } from "../quota.mjs";

const RATE_LIMIT_RE = /rate.?limit|429|too many requests/i;

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

// The strict copy codex demands, beside the transcript it belongs to. None when the
// schema has no strict form: codex then runs unbound and the re-ask is the backstop.
function writeStrictSchema(resultsDir, id, returns) {
  const strict = strictSchema(returns);
  if (strict === null) return undefined;
  const path = join(resultsDir, `${id}.schema.json`);
  writeFileSync(path, JSON.stringify(strict, null, 2));
  return path;
}

// Exported for src/ask.mjs — interrogation reuses the exact dispatch path.
export function runTask(task, prompt, cfg, io, leafLog, { onTokens, onActivity, onChild, onSession } = {}, runtime = {}) {
  return new Promise((resolve) => {
    // Codex only accepts a schema in strict form, and the builders stay pure — so the
    // strict copy is written here, where resultsDir already is.
    const schemaPath = task.returns && runtime.resultsDir
      ? writeStrictSchema(runtime.resultsDir, task.id, task.returns)
      : undefined;
    let dispatch;
    try {
      dispatch = buildDispatch(task, prompt, cfg, {
        providerRegistry: runtime.providerRegistry,
        runnerRegistry: runtime.runnerRegistry,
        cache: runtime.cache,
        schemaPath,
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
        // A leaf is a headless session: CORRELATION_ID is the marker every session hook
        // honours to stay out of autonomous runs, and it yields to a caller's own value
        // so a pipeline-launched swarm keeps its id. SWARM_LEAF never yields — a parent
        // claiming to be a leaf would arm foreground-guard's deny — and is spread LAST,
        // where neither env can unset it. SWARM_LEAF_GUARD/_PROJECT come from guardFor.
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
