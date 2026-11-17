// Tests for the reporter (`scripts/test-lib/reporter.mjs`): synthetic event
// streams in Node's probed order, where only the file-level complete is live.
// Clock, sleep and fs are injected, so a 60 s heartbeat costs no real time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import * as nodeFs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { HEARTBEAT_MS, abortableSleep, createReporter } from "./test-lib/reporter.mjs";

// --- Harness ---------------------------------------------------------------

function makeRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), "reporter-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

/** A clean env: inheriting process.env would make every run "agent mode"
 *  because this suite itself runs under one. */
function envFor(root, extra = {}) {
  return {
    TEST_RUN_LABEL: "unit",
    TEST_REPO_ROOT: root,
    TEST_RESULTS_DIR: join(root, "test-results"),
    ...extra,
  };
}

const neverSleep = () => new Promise(() => {});

/** A file row is named with the path as it was passed on the command line; the
 *  fixtures pass absolute paths, so that is what Node reports. */
function dequeue(file) {
  return { type: "test:dequeue", data: { file, name: file, nesting: 0, type: "test" } };
}

function complete(file, { passed = true, ms = 100 } = {}) {
  return {
    type: "test:complete",
    data: { file, name: file, nesting: 0, details: { duration_ms: ms, passed, type: "test" } },
  };
}

/** The file-level test:pass/fail: also emitted, but relayed in FILE order
 *  after the live complete, which is what the streaming test must not use. */
function fileResult(file, { passed = true, ms = 100 } = {}) {
  return {
    type: passed ? "test:pass" : "test:fail",
    data: { file, name: file, nesting: 0, details: { duration_ms: ms, type: "test" } },
  };
}

function start(file, name, nesting) {
  return { type: "test:start", data: { file, name, nesting } };
}

function leaf(kind, file, name, nesting, ms, error) {
  const details = { type: "test", duration_ms: ms };
  if (error) details.error = error;
  return { type: kind, data: { file, name, nesting, details } };
}

function summary(counts, durationMs) {
  return { type: "test:summary", data: { counts, duration_ms: durationMs } };
}

function stderr(file, message) {
  return { type: "test:stderr", data: { file, message } };
}

function events(list) {
  return (async function* source() {
    for (const event of list) yield event;
  })();
}

async function drain(reporter, source) {
  const chunks = [];
  for await (const chunk of reporter(source)) chunks.push(chunk);
  return chunks.join("");
}

async function until(predicate, what) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function withDeadline(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(what)), ms)),
  ]);
}

/** Sleeps that only the test settles, so "past 60 s" is a clock advance. */
function fakeClock() {
  let time = 0;
  const sleepers = [];
  const sleep = (ms, signal) => new Promise((resolve) => {
    const entry = { ms, resolve, aborted: false };
    sleepers.push(entry);
    if (signal) {
      signal.addEventListener("abort", () => {
        entry.aborted = true;
        resolve();
      }, { once: true });
    }
  });
  return {
    now: () => time,
    sleep,
    sleepers,
    advance: (ms) => {
      time += ms;
    },
    fire: () => sleepers.forEach((entry) => entry.resolve()),
  };
}

function lines(out) {
  return out.split("\n");
}

// --- A1 --------------------------------------------------------------------

test("A1: a file's line streams on test:complete, ahead of a slower file's detail", async (t) => {
  const root = makeRoot(t);
  const slow = join(root, "tests", "a-slow.test.mjs");
  const fast = join(root, "tests", "b-fast.test.mjs");
  const reporter = createReporter({ env: envFor(root), sleep: neverSleep, now: () => 0 });

  const source = events([
    dequeue(slow),
    dequeue(fast),
    complete(fast, { ms: 827 }), // live: b-fast ended first
    start(slow, "slow one", 0),
    leaf("test:pass", slow, "slow one", 0, 4000), // relayed in file order, last
    fileResult(slow, { ms: 4450 }),
    fileResult(fast, { ms: 827 }),
    complete(slow, { ms: 4450 }),
    summary({ tests: 2, passed: 2, failed: 0, skipped: 0, todo: 0 }, 4450),
  ]);
  const out = await drain(reporter, source);
  const rows = lines(out);
  const fastLine = rows.findIndex((row) => row.startsWith("✓") && row.includes("b-fast.test.mjs"));
  const slowLine = rows.findIndex((row) => row.startsWith("✓") && row.includes("a-slow.test.mjs"));
  assert.notEqual(fastLine, -1, out);
  assert.notEqual(slowLine, -1, out);
  assert.ok(fastLine < slowLine, `b-fast printed at ${fastLine}, a-slow at ${slowLine}\n${out}`);
  assert.match(rows[fastLine], /b-fast\.test\.mjs {2}0\.8s$/);
});

// --- A2 --------------------------------------------------------------------

test("A2: a failed file streams ✗ and the failure block names the test, the error and 20 stderr lines", async (t) => {
  const root = makeRoot(t);
  const file = join(root, "tests", "broken.test.mjs");
  const error = new Error("kaboom: expected 1 to be 2");
  error.stack = "Error: kaboom: expected 1 to be 2\n    at node:internal/test_runner/test:1:1";
  const failure = { code: "ERR_TEST_FAILURE", failureType: "testCodeFailure", cause: error };

  const reporter = createReporter({ env: envFor(root), sleep: neverSleep });
  const source = events([
    dequeue(file),
    start(file, "group", 0),
    ...Array.from({ length: 25 }, (_, i) => stderr(file, `stderr line ${i}\n`)),
    leaf("test:fail", file, "it breaks", 1, 12, failure),
    complete(file, { passed: false, ms: 300 }),
    summary({ tests: 1, passed: 0, failed: 1, skipped: 0, todo: 0 }, 300),
  ]);
  const out = await drain(reporter, source);

  const live = lines(out).find((row) => row.startsWith("✗"));
  assert.ok(live && live.includes("broken.test.mjs"), out);
  assert.match(out, /^FAIL tests\/broken\.test\.mjs > group > it breaks$/m);
  assert.match(out, /kaboom: expected 1 to be 2/);
  assert.ok(!out.includes("stderr line 0"), `the tail must drop the first 5 lines:\n${out}`);
  assert.match(out, /stderr line 24/);
  const tail = lines(out).filter((row) => /^stderr line \d+$/.test(row));
  assert.equal(tail.length, 20);
  assert.match(out, /^--- tests\/broken\.test\.mjs stderr \(last 20 lines\) ---$/m);
});

// --- A3 --------------------------------------------------------------------

test("the heartbeat sleep drops its abort listener once it fires", async () => {
  const controller = new AbortController();
  await abortableSleep(1, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("A3: an idle source gets a heartbeat naming the running file, and close settles the sleep", async (t) => {
  const root = makeRoot(t);
  const file = join(root, "tests", "a.test.mjs");
  const env = envFor(root);

  const clock = fakeClock();
  let calls = 0;
  const source = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      calls += 1;
      if (calls === 1) return Promise.resolve({ value: dequeue(file), done: false });
      return new Promise(() => {}); // never resolves: the run is still going
    },
  };

  const iterator = createReporter({ env, now: clock.now, sleep: clock.sleep })(source);
  const pending = iterator.next();
  await until(() => clock.sleepers.length >= 1 && calls >= 2, "the heartbeat sleep and a pending event");
  assert.equal(clock.sleepers[0].ms, HEARTBEAT_MS);

  clock.advance(HEARTBEAT_MS + 5000);
  clock.fire();
  const beat = await pending;
  assert.equal(beat.done, false);
  assert.match(beat.value, /^… still running \(65s\): tests\/a\.test\.mjs \(65s\)$/m);

  const closed = await withDeadline(iterator.return(), 1000, "closing after a heartbeat hung");
  assert.equal(closed.done, true);

  // Close while the sleep is still pending: the abort has to be what settles it.
  const clock2 = fakeClock();
  let calls2 = 0;
  const source2 = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      calls2 += 1;
      if (calls2 === 1) return Promise.resolve({ value: dequeue(file), done: false });
      return new Promise(() => {});
    },
  };
  const iterator2 = createReporter({ env, now: clock2.now, sleep: clock2.sleep })(source2);
  const pending2 = iterator2.next();
  await until(() => clock2.sleepers.length >= 1 && calls2 >= 2, "the second pending sleep");
  const closed2 = await withDeadline(iterator2.return(), 1000, "closing on a pending sleep hung");
  assert.equal(closed2.done, true);
  assert.equal(clock2.sleepers[0].aborted, true, "close must abort the pending sleep");
  await withDeadline(pending2, 1000, "the queued next() never settled");
});

// --- A5 / A10: agent mode --------------------------------------------------

const FIXTURE = [
  'import assert from "node:assert/strict";',
  'import { test } from "node:test";',
  'test("adds", () => {',
  "  assert.equal(1, 2);",
  "});",
  "",
].join("\n");

async function agentCase(t, agentEnv) {
  const root = makeRoot(t);
  const passFast = join(root, "tests", "pass-fast.test.mjs");
  const passSlow = join(root, "tests", "pass-slow.test.mjs");
  const failing = join(root, "tests", "fail.test.mjs");
  mkdirSync(dirname(failing), { recursive: true });
  writeFileSync(failing, FIXTURE, "utf8");

  const error = new Error("Expected values to be strictly equal:\n\n1 !== 2");
  error.stack = `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n1 !== 2\n    at TestContext.<anonymous> (${pathToFileURL(failing).href}:4:10)\n    at Test.runInAsyncScope (node:async_hooks:227:14)`;

  const reporter = createReporter({ env: envFor(root, agentEnv), sleep: neverSleep });
  const source = events([
    dequeue(passFast), dequeue(passSlow), dequeue(failing),
    complete(passFast, { ms: 200 }),
    complete(passSlow, { ms: 40000 }),
    start(passFast, "fast test", 0), leaf("test:pass", passFast, "fast test", 0, 200),
    start(passSlow, "slow test", 0), leaf("test:pass", passSlow, "slow test", 0, 40000),
    start(failing, "adds", 0),
    leaf("test:fail", failing, "adds", 0, 5, { code: "ERR_TEST_FAILURE", failureType: "testCodeFailure", cause: error }),
    complete(failing, { passed: false, ms: 5 }),
    summary({ tests: 3, passed: 2, failed: 1, skipped: 0, todo: 0 }, 40205),
  ]);
  const out = await drain(reporter, source);

  assert.ok(!out.includes("✓"), `agent mode printed passing work:\n${out}`);
  assert.ok(!out.includes("slowest tests"), out);
  assert.ok(!/^totals:/m.test(out), out);
  assert.match(out, /^FAIL tests\/fail\.test\.mjs > adds$/m);
  assert.match(out, /^ {2}AssertionError \[ERR_ASSERTION\]: Expected values to be strictly equal:/m);
  assert.match(out, /1 !== 2/);

  // The code frame: header, the failing source line marked, and a caret under
  // the failing column.
  const rows = lines(out);
  const header = rows.findIndex((row) => row === "tests/fail.test.mjs:4:10");
  assert.notEqual(header, -1, out);
  const marked = rows.findIndex((row, i) => i > header && row.startsWith("> "));
  assert.match(rows[marked], /assert\.equal\(1, 2\);/);
  const caretRow = rows[marked + 1];
  assert.equal(caretRow.indexOf("^") - (caretRow.indexOf("| ") + 2), 9, `caret column\n${out}`);

  const log = readFileSync(join(root, "test-results", "unit.log"), "utf8");
  for (const name of ["fast test", "slow test", "adds", "pass-fast.test.mjs", "pass-slow.test.mjs", "fail.test.mjs"]) {
    assert.ok(log.includes(name), `the log must hold ${name}:\n${log}`);
  }
}

test("A5: CLAUDECODE=1 gives agent output", async (t) => {
  await agentCase(t, { CLAUDECODE: "1" });
});

test("A5: AI_AGENT alone gives agent output", async (t) => {
  await agentCase(t, { AI_AGENT: "x" });
});

test("A10: --reporter overrides agent detection in both directions", async (t) => {
  const root = makeRoot(t);
  const file = join(root, "tests", "pass.test.mjs");
  const source = () => events([
    dequeue(file),
    start(file, "ok", 0),
    leaf("test:pass", file, "ok", 0, 50),
    complete(file, { ms: 60 }),
    summary({ tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0 }, 60),
  ]);

  const forcedDefault = await drain(
    createReporter({ env: envFor(root, { CLAUDECODE: "1", TEST_REPORTER: "default" }), sleep: neverSleep }),
    source(),
  );
  assert.match(forcedDefault, /^✓ tests\/pass\.test\.mjs {2}0\.1s$/m);
  assert.match(forcedDefault, /^totals:/m);

  const forcedAgent = await drain(
    createReporter({ env: envFor(root, { TEST_REPORTER: "agent" }), sleep: neverSleep }),
    source(),
  );
  assert.equal(forcedAgent, "");
});

// --- A6 --------------------------------------------------------------------

test("A6: the end block lists the 10 slowest tests, slowest first", async (t) => {
  const root = makeRoot(t);
  const file = join(root, "tests", "timed.test.mjs");
  const durations = Array.from({ length: 12 }, (_, i) => 1200 + i * 100);
  const stream = [dequeue(file)];
  for (let i = 0; i < durations.length; i++) {
    stream.push(start(file, `test ${i}`, 0), leaf("test:pass", file, `test ${i}`, 0, durations[i]));
  }
  stream.push(complete(file, { ms: 20000 }), summary({ tests: 12, passed: 12, failed: 0, skipped: 0, todo: 0 }, 20000));

  const out = await drain(createReporter({ env: envFor(root), sleep: neverSleep }), events(stream));
  const rows = lines(out).filter((row) => /^\s+\d+ms {2}/.test(row));
  assert.equal(rows.length, 10, out);
  assert.deepEqual(
    rows.map((row) => Number(/(\d+)ms/.exec(row)[1])),
    [2300, 2200, 2100, 2000, 1900, 1800, 1700, 1600, 1500, 1400],
  );
});

// --- Integration surface for the runner ------------------------------------

test("a file that crashes at load still prints, with its stderr as the failure evidence", async (t) => {
  const root = makeRoot(t);
  const file = join(root, "tests", "crash.test.mjs");
  const reporter = createReporter({ env: envFor(root, { TEST_REPORTER: "agent" }), sleep: neverSleep });
  const source = events([
    dequeue(file),
    stderr(file, "Error: load crash\n"),
    stderr(file, "    at file:///x/crash.test.mjs:1:7\n"),
    complete(file, { passed: false, ms: 400 }),
    summary({ tests: 0, passed: 0, failed: 1, skipped: 0, todo: 0 }, 400),
  ]);
  const out = await drain(reporter, source);
  assert.match(out, /^✗ tests\/crash\.test\.mjs {2}0\.4s$/m);
  assert.match(out, /^FAIL tests\/crash\.test\.mjs$/m);
  assert.match(out, /Error: load crash/);
});

test("a file row named by a cwd-relative path is recognised as the file", async (t) => {
  const repoRoot = process.cwd();
  const file = "scripts/relative-name.test.mjs";
  const out = await drain(
    createReporter({
      env: { TEST_RUN_LABEL: "unit", TEST_REPO_ROOT: repoRoot, TEST_RESULTS_DIR: makeRoot(t) },
      sleep: neverSleep,
    }),
    events([dequeue(file), complete(file, { ms: 900 })]),
  );
  assert.match(out, /^✓ scripts\/relative-name\.test\.mjs {2}0\.9s$/m);
});

test("the in-flight record is written per pid on file start and cleared at the end", async (t) => {
  const root = makeRoot(t);
  const file = join(root, "tests", "a.test.mjs");
  const flight = join(root, "test-results", `unit.${process.pid}.inflight.json`);
  const seen = [];

  const source = (async function* () {
    yield dequeue(file);
    seen.push(readFileSync(flight, "utf8"));
    yield complete(file, { ms: 500 });
  })();

  const out = await drain(createReporter({ env: envFor(root), sleep: neverSleep, now: () => 1000 }), source);
  assert.match(out, /✓ tests\/a\.test\.mjs/);
  assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(seen[0]), {
    pid: process.pid,
    label: "unit",
    files: [{ file: "tests/a.test.mjs", startedAt: 1000 }],
  });
  assert.ok(existsSync(flight));
  assert.deepEqual(JSON.parse(readFileSync(flight, "utf8")).files, []);
});

test("timings are keyed by the repo-relative path with the file's content hash", async (t) => {
  const root = makeRoot(t);
  const file = join(root, "tests", "landed.test.mjs");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "// fixture\n", "utf8");
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");

  await drain(
    createReporter({ env: envFor(root), sleep: neverSleep, now: () => 42 }),
    events([dequeue(file), complete(file, { ms: 45000 })]),
  );
  const timings = JSON.parse(readFileSync(join(root, "test-results", "timings.json"), "utf8"));
  assert.deepEqual(timings["tests/landed.test.mjs"], { ms: 45000, sha256, at: 42 });
});

test("the timing cache is written once per run, through fast.recordTimings", async (t) => {
  const root = makeRoot(t);
  const a = join(root, "tests", "a.test.mjs");
  const b = join(root, "tests", "b.test.mjs");
  mkdirSync(dirname(a), { recursive: true });
  writeFileSync(a, "// a\n", "utf8");
  writeFileSync(b, "// b\n", "utf8");
  let writes = 0;
  const fs = {
    ...nodeFs,
    renameSync: (from, to) => {
      if (String(to).endsWith("timings.json")) writes += 1;
      return nodeFs.renameSync(from, to);
    },
  };

  await drain(
    createReporter({ env: envFor(root), sleep: neverSleep, now: () => 7, fs }),
    events([dequeue(a), complete(a, { ms: 1200 }), dequeue(b), complete(b, { ms: 3400 })]),
  );

  const timings = JSON.parse(readFileSync(join(root, "test-results", "timings.json"), "utf8"));
  assert.deepEqual(Object.keys(timings).sort(), ["tests/a.test.mjs", "tests/b.test.mjs"]);
  assert.equal(writes, 1, "each finished file rewrote the whole timing cache");
});
