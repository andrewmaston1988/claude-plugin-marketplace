// The node --test reporter that makes a run's silence meaningful.
//
// Node relays per-test events in FILE order, so only the file-level complete is
// live: the line prints there, and a heartbeat covers everything else.

import * as nodeFs from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { recordTimings } from "./fast.mjs";

export const HEARTBEAT_MS = 60_000;
// A run killed at its cap never reaches the end-of-run write, so completed
// timings are also flushed on this cadence: a kill loses at most the last minute.
export const TIMINGS_FLUSH_MS = 60_000;
export const SLOW_TEST_MS = 1_000;
export const SLOW_TEST_LIMIT = 10;
export const STDERR_TAIL_LINES = 20;

// std-env's agent variables (plus CLAUDECODE, which it also checks). Its PATH,
// EDITOR and TERM_PROGRAM heuristics are deliberately not copied: a path match
// is not a variable and would flip an ordinary developer run into agent mode.
const AGENT_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE",
  "REPL_ID",
  "GEMINI_CLI",
  "CODEX_SANDBOX",
  "CODEX_THREAD_ID",
  "OPENCODE",
  "AUGMENT_AGENT",
  "GOOSE_PROVIDER",
  "JUNIE_DATA",
  "JUNIE_SHIM_PATH",
  "COPILOT_AGENT",
  "COPILOT_CLI",
  "CURSOR_AGENT",
];

/** Vitest's rule: an explicit AI_AGENT, or an agent's own variable, means the
 *  reader is a program. A reporter flag beats both. */
export function resolveMode(env) {
  if (env.TEST_REPORTER === "agent" || env.TEST_REPORTER === "default") return env.TEST_REPORTER;
  if (env.AI_AGENT !== undefined && env.AI_AGENT !== "") return "agent";
  return AGENT_VARS.some((name) => env[name]) ? "agent" : "default";
}

/** Resolves on the timer OR on abort, so a closed generator never leaves the
 *  loop waiting on a heartbeat that will not fire. The listener is dropped on
 *  either path: one that accumulates would trip Node's listener warning. */
export function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    let timer = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
}

// --- Paths -----------------------------------------------------------------

function toPosix(path) {
  return path.split(sep).join("/");
}

function absPath(file, cwd) {
  if (file.startsWith("file://")) {
    try {
      return fileURLToPath(file);
    } catch {
      return file;
    }
  }
  return isAbsolute(file) ? file : join(cwd, file);
}

/** Repo-relative posix path, or the absolute path when the file sits outside
 *  the repository (a fixture in a temp directory, say). */
function repoRel(file, { repoRoot, cwd }) {
  const abs = absPath(file, cwd);
  if (!repoRoot) return toPosix(abs);
  const rel = relative(repoRoot, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return toPosix(abs);
  return toPosix(rel);
}

function display(file, { repoRoot, cwd }) {
  return repoRel(file, { repoRoot, cwd });
}

// --- Failures --------------------------------------------------------------

function errorText(error) {
  if (!error) return "";
  const cause = error.cause;
  if (typeof cause === "string") return cause;
  if (cause && typeof cause === "object") {
    if (typeof cause.stack === "string" && cause.stack) return cause.stack.trimEnd();
    if (typeof cause.message === "string" && cause.message) return cause.message;
  }
  if (typeof error.stack === "string" && error.stack) return error.stack.trimEnd();
  return error.code ? String(error.code) : "";
}

function indentBlock(text) {
  return text.split(/\r?\n/).map((line) => (line ? `  ${line}` : line));
}

/** The first stack frame inside the test file: the test's own line, not the
 *  runner internals every failure shares. */
function firstFrameIn(error, targetAbs) {
  const stack = errorText(error);
  if (!stack) return null;
  const needles = [targetAbs, toPosix(targetAbs)];
  try {
    needles.push(pathToFileURL(targetAbs).href);
  } catch {
    // A path Node cannot turn into a URL cannot appear in the stack either.
  }
  for (const line of stack.split(/\r?\n/)) {
    for (const needle of needles) {
      const at = line.indexOf(needle);
      if (at === -1) continue;
      const match = /^:(\d+):(\d+)/.exec(line.slice(at + needle.length));
      if (match) return { line: Number(match[1]), column: Number(match[2]) };
    }
  }
  return null;
}

function codeFrameFor({ key, abs, error, fs }) {
  const frame = firstFrameIn(error, abs);
  if (!frame) return [];
  let text;
  try {
    text = String(fs.readFileSync(abs, "utf8"));
  } catch {
    return [`${key}:${frame.line}:${frame.column}`];
  }
  const source = text.split(/\r?\n/);
  const from = Math.max(1, frame.line - 2);
  const to = Math.min(source.length, frame.line + 2);
  const width = String(to).length;
  const out = [`${key}:${frame.line}:${frame.column}`];
  for (let n = from; n <= to; n++) {
    out.push(`${n === frame.line ? "> " : "  "}${String(n).padStart(width)} | ${source[n - 1]}`);
    if (n === frame.line) {
      out.push(`  ${" ".repeat(width)} | ${" ".repeat(Math.max(0, frame.column - 1))}^`);
    }
  }
  return out;
}

// --- Formatting ------------------------------------------------------------

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function slowLines(slow, heading = `slowest tests (over ${SLOW_TEST_MS}ms):`) {
  if (slow.length === 0) return [];
  const sorted = [...slow].sort((a, b) => b.ms - a.ms).slice(0, SLOW_TEST_LIMIT);
  return [heading, ...sorted.map((entry) => {
    const path = [entry.file, ...entry.chain, entry.name].join(" > ");
    return `  ${String(Math.round(entry.ms)).padStart(5)}ms  ${path}`;
  })];
}

function totalsLines(totals) {
  const counts = totals && totals.counts;
  if (!counts) return [];
  const duration = typeof totals.duration_ms === "number" ? ` -- ${seconds(totals.duration_ms)}` : "";
  return [`totals: ${counts.tests} tests, ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped ?? 0} skipped, ${counts.todo ?? 0} todo${duration}`];
}

/** Node names a file-level row with the path exactly as it was passed on the
 *  command line -- `tests/a.test.mjs`, or the whole path when absolute -- so the
 *  row is identified by resolving that name back onto the file. */
function isFileLevel(data, cwd) {
  if (!Boolean(data) || data.nesting !== 0) return false;
  if (typeof data.name !== "string" || typeof data.file !== "string") return false;
  const abs = absPath(data.file, cwd);
  return resolve(cwd, data.name) === resolve(abs);
}

// --- Reporter --------------------------------------------------------------

/** Injected `now`, `sleep`, `env` and `fs` are what let a test advance the
 *  clock instead of waiting a real minute. */
export function createReporter({ now = Date.now, sleep = abortableSleep, env = process.env, fs = nodeFs } = {}) {
  const mode = resolveMode(env);
  // TEST_RUN_LABEL names the log, timings and in-flight records; TEST_RESULTS_DIR
  // holds them; TEST_REPO_ROOT is what their paths are relative to.
  const label = env.TEST_RUN_LABEL || "test";
  const cwd = process.cwd();
  const repoRoot = env.TEST_REPO_ROOT || "";
  const resultsDir = env.TEST_RESULTS_DIR || join(repoRoot || cwd, "test-results");
  const paths = { repoRoot, cwd };

  function writeAtomic(path, text) {
    try {
      fs.mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, path);
    } catch {
      // Reporting state must never fail a run: a read-only results directory
      // costs the log, not the tests.
    }
  }

  async function* run(source, abort) {
    const startedAt = now();
    const running = new Map();      // repo-relative path -> start ms
    const files = new Map();        // repo-relative path -> { passed, ms, error, tests }
    const chains = new Map();       // repo-relative path -> ancestor names by nesting
    const failures = new Map();     // repo-relative path -> leaf failures
    const stderr = new Map();       // repo-relative path -> last lines
    const failedFiles = [];         // completion order
    const measured = [];            // { file, ms } of passing files, flushed in batches
    const slow = [];
    let totals = null;
    let flushed = 0;                // measured entries already persisted
    let lastFlush = startedAt;

    const inFlightPath = () => join(resultsDir, `${label}.${process.pid}.inflight.json`);

    /** One timings writer: recordTimings merges the batch into the cache. */
    function flushTimings() {
      if (measured.length === flushed) return;
      const entries = measured.slice(flushed);
      flushed = measured.length;
      lastFlush = now();
      recordTimings({ resultsDir, repoRoot, entries, now, _fs: fs });
    }

    function maybeFlushTimings() {
      if (measured.length > flushed && now() - lastFlush >= TIMINGS_FLUSH_MS) flushTimings();
    }

    function writeInFlight() {
      const payload = {
        pid: process.pid,
        label,
        files: [...running].map(([file, startedAtMs]) => ({ file, startedAt: startedAtMs })),
      };
      writeAtomic(inFlightPath(), `${JSON.stringify(payload)}\n`);
    }

    function fileRecord(key) {
      if (!files.has(key)) files.set(key, { passed: true, ms: 0, error: null, tests: [] });
      return files.get(key);
    }

    function failureBlock(key) {
      const lines = [];
      const leaf = failures.get(key) || [];
      if (leaf.length === 0) {
        // A file that crashed at load has no leaf failure; its file-level error
        // and stderr are the only evidence there is.
        lines.push(`FAIL ${key}`);
        const text = errorText(fileRecord(key).error);
        if (text) lines.push(...indentBlock(text));
      }
      for (const entry of leaf) {
        lines.push(`FAIL ${[key, ...entry.chain, entry.name].join(" > ")}`);
        const text = errorText(entry.error);
        if (text) lines.push(...indentBlock(text));
        lines.push(...codeFrameFor({ key, abs: absPath(entry.abs, cwd), error: entry.error, fs }));
      }
      const tail = stderr.get(key) || [];
      if (tail.length > 0) lines.push(`--- ${key} stderr (last ${tail.length} lines) ---`, ...tail);
      return lines;
    }

    function endLines() {
      const lines = [];
      const failed = [...failedFiles];
      for (const key of failures.keys()) if (!failed.includes(key)) failed.push(key);
      for (const key of failed) {
        if (lines.length > 0) lines.push("");
        lines.push(...failureBlock(key));
      }
      if (mode === "default") {
        const slowBlock = slowLines(slow);
        const totalBlock = totalsLines(totals);
        if (slowBlock.length > 0) {
          if (lines.length > 0) lines.push("");
          lines.push(...slowBlock);
        }
        if (totalBlock.length > 0) {
          if (lines.length > 0) lines.push("");
          lines.push(...totalBlock);
        }
      }
      return lines;
    }

    function logText() {
      const lines = [];
      for (const [key, record] of files) {
        lines.push(`${record.passed ? "✓" : "✗"} ${key}  ${seconds(record.ms)}`);
        for (const entry of record.tests) {
          const path = [...entry.chain, entry.name].join(" > ");
          lines.push(`${"  ".repeat(entry.chain.length + 1)}${entry.passed ? "✓" : "✗"} ${path}  ${Math.round(entry.ms)}ms`);
        }
      }
      const slowBlock = slowLines(slow);
      const totalBlock = totalsLines(totals);
      if (slowBlock.length > 0) lines.push("", ...slowBlock);
      if (totalBlock.length > 0) lines.push("", ...totalBlock);
      return `${lines.join("\n")}\n`;
    }

    function heartbeat() {
      if (running.size === 0) return null;
      const at = now();
      const elapsed = Math.round((at - startedAt) / 1000);
      const names = [...running].map(([file, since]) => `${file} (${Math.round((at - since) / 1000)}s)`);
      return `… still running (${elapsed}s): ${names.join(", ")}\n`;
    }

    function handle(event) {
      const data = event && event.data;
      if (!data) return null;
      const file = typeof data.file === "string" ? data.file : "";
      switch (event.type) {
        case "test:dequeue": {
          if (!isFileLevel(data, cwd)) return null;
          const key = display(file, paths);
          running.set(key, now());
          writeInFlight();
          return null;
        }
        case "test:complete": {
          if (!isFileLevel(data, cwd)) return null; // nested completes duplicate test:pass/fail
          const key = display(file, paths);
          const details = data.details || {};
          const passed = details.passed !== false;
          const ms = typeof details.duration_ms === "number"
            ? details.duration_ms
            : now() - (running.get(key) ?? startedAt);
          running.delete(key);
          const record = fileRecord(key);
          record.passed = passed;
          record.ms = ms;
          record.error = details.error || null;
          writeInFlight();
          // Failing files are not measured: --fast must never skip a file that
          // is currently failing.
          if (passed) measured.push({ file: key, ms });
          else failedFiles.push(key);
          return mode === "default" || !passed ? `${passed ? "✓" : "✗"} ${key}  ${seconds(ms)}\n` : null;
        }
        case "test:start": {
          const key = display(file, paths);
          const chain = chains.get(key) || [];
          chain[data.nesting] = data.name;
          chain.length = data.nesting + 1;
          chains.set(key, chain);
          return null;
        }
        case "test:pass":
        case "test:fail": {
          if (isFileLevel(data, cwd)) return null;
          const details = data.details || {};
          if (details.type !== "test") return null; // a suite row only restates its children
          const key = display(file, paths);
          const chain = (chains.get(key) || []).slice(0, data.nesting);
          const ms = typeof details.duration_ms === "number" ? details.duration_ms : 0;
          const passed = event.type === "test:pass";
          fileRecord(key).tests.push({ name: data.name, chain, ms, passed });
          if (ms > SLOW_TEST_MS) slow.push({ file: key, chain, name: data.name, ms });
          if (!passed && details.error?.failureType !== "subtestsFailed") {
            if (!failures.has(key)) failures.set(key, []);
            failures.get(key).push({ abs: file, chain, name: data.name, error: details.error });
          }
          return null;
        }
        case "test:stderr": {
          if (typeof data.file !== "string") return null;
          const key = display(data.file, paths);
          const incoming = String(data.message ?? "").split(/\r?\n/);
          if (incoming[incoming.length - 1] === "") incoming.pop();
          const tail = stderr.get(key) || [];
          tail.push(...incoming);
          if (tail.length > STDERR_TAIL_LINES) tail.splice(0, tail.length - STDERR_TAIL_LINES);
          stderr.set(key, tail);
          return null;
        }
        case "test:summary": {
          if (data.file === undefined) totals = data; // the final aggregate only
          return null;
        }
        default:
          return null;
      }
    }

    const iterator = source[Symbol.asyncIterator]();
    const HEARTBEAT = Symbol("heartbeat");
    let pending = iterator.next();
    let sleeper = null;

    try {
      while (true) {
        if (!sleeper) {
          const elapsed = now() - startedAt;
          const mark = (Math.floor(elapsed / HEARTBEAT_MS) + 1) * HEARTBEAT_MS;
          sleeper = sleep(Math.max(1, mark - elapsed), abort.signal).then(() => HEARTBEAT);
        }
        const winner = await Promise.race([pending, sleeper]);
        if (abort.signal.aborted) break; // the consumer closed us; do not emit more
        if (winner === HEARTBEAT) {
          sleeper = null;
          maybeFlushTimings();
          const line = heartbeat();
          if (line) yield line;
          continue;
        }
        const { value, done } = winner;
        if (done) break;
        // Handle before pulling the next event: an async generator's next()
        // resumes its body synchronously, so pulling first would let the run
        // advance past state this event wrote.
        const out = handle(value);
        maybeFlushTimings();
        if (out) yield out;
        pending = iterator.next();
      }
      flushTimings();
      writeAtomic(join(resultsDir, `${label}.log`), logText());
      running.clear();
      writeInFlight();
      const lines = endLines();
      if (lines.length > 0) yield `${lines.join("\n")}\n`;
    } finally {
      abort.abort();
      try {
        flushTimings(); // a closed generator still owns the files that finished
      } catch {
        // The cache is an optimisation; a run must never fail over it.
      }
      // Not awaited: a source suspended on its own await cannot settle its
      // return(), and close must not block on it.
      try {
        const returned = typeof iterator.return === "function" ? iterator.return() : null;
        if (returned && typeof returned.catch === "function") returned.catch(() => {});
      } catch {
        // The source is already finished or broken; nothing to recover.
      }
    }
  }

  /** The abort has to fire before the pending sleep settles, and only the
   *  consumer knows when that is -- so the iterator is wrapped rather than
   *  handed out raw.
   *
   *  An arrow function on purpose: Node's reporter loader runs `new reporter()`
   *  on any default export whose prototype owns a `constructor`, and calls the
   *  result with no source. */
  return (source) => {
    const abort = new AbortController();
    const inner = run(source, abort);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: (value) => inner.next(value),
      throw: (error) => inner.throw(error),
      return: async (value) => {
        abort.abort();
        const result = await inner.return(value);
        return result.done ? result : { done: true, value: result.value };
      },
    };
  };
}

export default createReporter();
