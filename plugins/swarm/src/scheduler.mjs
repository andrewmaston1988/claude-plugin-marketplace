import { mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { buildDispatch, toSpawnable } from "./dispatch.mjs";
import { isClaudeModel } from "./models.mjs";
import { buildDigestTask } from "./digest.mjs";
import {
  initResultsDir, resultPath, writeResult, readResult, writeSummary,
  writeDigestMd, appendRunLog, formatStatusLine,
} from "./results.mjs";
import * as defaultWorktree from "./worktree.mjs";

const RATE_LIMIT_RE = /rate.?limit|429|too many requests/i;
const OK_STATES = new Set(["ok", "skipped"]);
const TEMPLATE_RE = /\{\{(result|resultPath):([^}]*)\}\}/g;

// Default io: real spawn (with Windows .cmd resolution), real fetch/clock,
// status lines to stdout. Every part is injectable so tests never hit the
// network or a real claude.
export function makeDefaultIo() {
  return {
    spawn: (cmd, args, opts) => {
      const s = toSpawnable([cmd, ...args]);
      return nodeSpawn(s.cmd, s.args, opts);
    },
    fetch: (...a) => globalThis.fetch(...a),
    now: () => Date.now(),
    stdout: (line) => process.stdout.write(line + "\n"),
    env: process.env,
  };
}

// Materialize {{result:id}} / {{resultPath:id}} against completed dep results.
export function substituteTemplates(prompt, resultsDir, cap) {
  return prompt.replace(TEMPLATE_RE, (whole, kind, id) => {
    if (kind === "resultPath") return resultPath(resultsDir, id);
    const res = readResult(resultsDir, id);
    const out = String(res?.output ?? "");
    return out.length > cap ? out.slice(0, cap) : out;
  });
}

// Classify a non-zero completion. Rate-limit-shaped failures are 'rate-limited'
// — retryable via resume — instead of 'failed'. The only error-classification
// logic in the engine.
export function classifyFailure({ timedOut, output }) {
  if (timedOut) return "failed:timeout";
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

function runTask(task, prompt, cfg, io, leafLog) {
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
      leafLog?.end(`spawn error: ${e.message}\n`);
      resolve({ ok: false, exit: null, durationMs: 0, output: `spawn error: ${e.message}`, timedOut: false });
      return;
    }
    let output = "";
    let timedOut = false;
    let settled = false;
    // Progressive capture: stream to results/<id>.log as data arrives so a
    // user can tail an individual leaf mid-run; the buffered copy still lands
    // in the result JSON's output field.
    child.stdout?.on("data", (d) => { output += d; leafLog?.write(d); });
    child.stderr?.on("data", (d) => { output += d; leafLog?.write(d); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* already gone */ }
    }, task.timeoutMs);
    if (timer.unref) timer.unref();
    const settle = (exit, errMsg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (errMsg) output += (output ? "\n" : "") + errMsg;
      leafLog?.end();
      resolve({
        ok: exit === 0 && !timedOut,
        exit,
        durationMs: io.now() - started,
        output: String(output),
        timedOut,
      });
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
  const byId = new Map(tasks.map((t) => [t.id, t]));

  initResultsDir(plan.resultsDir);

  // Health check, once per run, only when any open-model task exists: any
  // response from the provider endpoint counts as up; fail the run fast with
  // a clear message when it is unreachable.
  if (tasks.some((t) => !isClaudeModel(t.model))) {
    try {
      await io.fetch(cfg.provider.url);
    } catch (e) {
      throw new Error(
        `provider endpoint ${cfg.provider.url} is unreachable (${e.message}) — ` +
        `open-model tasks cannot dispatch. Is the provider running?`
      );
    }
  }

  const started = new Date().toISOString();
  // run-start line lets `status` derive pending tasks (ids never seen since
  // the latest run-start are pending).
  appendRunLog(plan.resultsDir, { ts: started, event: "run-start", tasks: tasks.map((t) => t.id) });
  const state = new Map(tasks.map((t) => [t.id, "pending"]));
  const durations = new Map();
  const worktreesKept = [];
  let digestPath = null;
  let digestFailed = false;

  const record = (task, st, durationMs) => {
    state.set(task.id, st);
    if (durationMs != null) durations.set(task.id, durationMs);
    appendRunLog(plan.resultsDir, { ts: new Date().toISOString(), id: task.id, state: st });
    if (st !== "running") {
      io.stdout(formatStatusLine({ id: task.id, model: task.model, state: st, durationMs }));
    }
  };

  // Resume: an existing ok result satisfies the task without re-running it.
  if (!force) {
    for (const t of tasks) {
      const prior = readResult(plan.resultsDir, t.id);
      if (prior && prior.ok === true) {
        record(t, "skipped");
        if (t.isDigest) digestPath = writeDigestMd(plan.resultsDir, prior.output);
      }
    }
  }

  const running = new Map(); // id -> promise resolving to task id

  const depsSatisfied = (t) => t.after.every((d) => OK_STATES.has(state.get(d)));
  const depsDoomed = (t) => t.after.some((d) => {
    const s = state.get(d);
    return s !== undefined && !OK_STATES.has(s) && s !== "pending" && s !== "running";
  });

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

      const prompt = substituteTemplates(task.prompt, plan.resultsDir, cfg.resultInlineCap ?? 4000);
      const leafLog = createWriteStream(join(plan.resultsDir, "results", `${task.id}.log`));
      const r = await runTask({ ...task, cwd: taskCwd }, prompt, cfg, io, leafLog);

      const result = {
        id: task.id,
        model: task.model,
        ok: r.ok,
        exit: r.exit,
        durationMs: r.durationMs,
        output: r.output,
      };
      const parsed = tryParseJson(r.output);
      if (parsed !== undefined) result.outputJson = parsed;

      if (wt) {
        const collected = worktree.collect(task, cfg, wt);
        result.worktree = collected;
        if (collected.kept) worktreesKept.push({ id: task.id, branch: collected.branch, path: collected.path, diffstat: collected.diffstat });
      }

      writeResult(plan.resultsDir, task.id, result);

      if (task.isDigest) {
        if (r.ok) digestPath = writeDigestMd(plan.resultsDir, r.output);
        else digestFailed = true;
      }

      record(task, r.ok ? "ok" : classifyFailure(r), r.durationMs);
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

    for (const t of tasks) {
      if (running.size >= plan.concurrency) break;
      if (state.get(t.id) === "pending" && depsSatisfied(t)) launch(t);
    }

    if (running.size === 0) break;
    const finished = await Promise.race(running.values());
    running.delete(finished);
  }

  const summary = {
    started,
    finished: new Date().toISOString(),
    tasks: tasks.map((t) => ({
      id: t.id,
      state: state.get(t.id),
      durationMs: durations.get(t.id) ?? null,
      resultPath: resultPath(plan.resultsDir, t.id),
    })),
    blocked: tasks.filter((t) => state.get(t.id) === "blocked").map((t) => t.id),
    worktreesKept,
  };
  const summaryPath = writeSummary(plan.resultsDir, summary);

  return { summary, summaryPath, digestPath, digestFailed, worktreesKept };
}
