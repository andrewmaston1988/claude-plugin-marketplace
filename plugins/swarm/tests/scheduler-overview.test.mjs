import { test } from "node:test";
import { equal, deepEqual, ok, match } from "node:assert/strict";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn } from "node:child_process";
import { oracleSnapKey } from "./helpers/snap-key.mjs";
import { runPlan, classifyFailure, pickNewestRunning } from "../src/scheduler.mjs";
import { writeResult, readResult } from "../src/results.mjs";
import { CFG, tmp, task, plan, computeTask, childPlanOf, fakeSpawnFactory, makeIo, promptOf, sentPrompt, usageEnv, codexReading, SHIM, streamOut, gitInRepo, initGitRepo, commitAllInRepo, fakeWorktree, buildStrandPlan, integrateLeaf, forEachFixLeaf, fixCloneTasks } from "./helpers/scheduler-fixtures.mjs";

test("fan-out: all tasks run, results + summary + run.log written", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "leaf says hi" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a"), task("b"), task("c")]);
    const r = await runPlan(p, CFG, io);

    equal(spawn.calls.length, 3);
    for (const id of ["a", "b", "c"]) {
      const res = readResult(p.resultsDir, id);
      equal(res.ok, true);
      equal(res.exit, 0);
      equal(res.output, "leaf says hi");
    }
    const summary = JSON.parse(readFileSync(r.summaryPath, "utf8"));
    deepEqual(summary.tasks.map((t) => t.state), ["ok", "ok", "ok"]);
    deepEqual(summary.blocked, []);
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    equal(logLines.length, 7); // run-start + (running + terminal) per task
    equal(logLines[0].event, "run-start");
    deepEqual(logLines[0].tasks, [
      { id: "a", provider: "claude", runner: "claude", model: "claude-haiku-4-5-20251001" }, { id: "b", provider: "claude", runner: "claude", model: "claude-haiku-4-5-20251001" }, { id: "c", provider: "claude", runner: "claude", model: "claude-haiku-4-5-20251001" },
    ]);
    ok(existsSync(join(p.resultsDir, ".gitignore")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── launcher stamp ─────────────────────────────────────────────────────────────
// The dispatching session's CLAUDE_CODE_SESSION_ID rides the run-start line so
// the statusline's session filter and the per-turn grading nudge can attribute
// runs. Env must be held for the whole awaited runPlan — restoring it before the
// async body reaches the append would race the stamp.
async function withSessionEnv(id, fn) {
  const had = process.env.CLAUDE_CODE_SESSION_ID;
  if (id === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = id;
  try {
    return await fn();
  } finally {
    if (had === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = had;
  }
}

function firstLogLine(resultsDir) {
  return JSON.parse(readFileSync(join(resultsDir, "run.log"), "utf8").split("\n")[0]);
}

test("run-start carries the dispatching session id as launcher", async () => {
  const dir = tmp();
  try {
    const p = plan(dir, [task("a")]);
    await withSessionEnv("abc", () => runPlan(p, CFG, makeIo(fakeSpawnFactory(() => ({ output: "x" })))));
    const first = firstLogLine(p.resultsDir);
    equal(first.event, "run-start");
    equal(first.launcher, "abc");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no CLAUDE_CODE_SESSION_ID -> no launcher: the run belongs to nobody", async () => {
  const dir = tmp();
  try {
    const p = plan(dir, [task("a")]);
    await withSessionEnv(undefined, () => runPlan(p, CFG, makeIo(fakeSpawnFactory(() => ({ output: "x" })))));
    const first = firstLogLine(p.resultsDir);
    equal(first.event, "run-start");
    ok(!("launcher" in first), `launcher must be absent, got ${JSON.stringify(first.launcher)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a resume re-stamps: the last run-start carries the resumer's session id", async () => {
  const dir = tmp();
  try {
    const p = plan(dir, [task("a")]);
    const io = makeIo(fakeSpawnFactory(() => ({ output: "x" })));
    await withSessionEnv("abc", () => runPlan(p, CFG, io));
    await withSessionEnv("xyz", () => runPlan(p, CFG, io)); // same resultsDir — a resume
    const starts = readFileSync(join(p.resultsDir, "run.log"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === "run-start");
    equal(starts.length, 2);
    equal(starts[0].launcher, "abc");
    equal(starts.at(-1).launcher, "xyz");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chain order: a runs before b, b before c", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "x" }));
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("c", { after: ["b"] }),
      task("a"),
      task("b", { after: ["a"] }),
    ]);
    await runPlan(p, CFG, io);
    const order = spawn.calls.map(promptOf);
    deepEqual(order, ["do a", "do b", "do c"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrency cap respected", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ delayMs: 25 }));
    const io = makeIo(spawn);
    const p = plan(dir, ["a", "b", "c", "d", "e", "f"].map((id) => task(id)), { concurrency: 2 });
    await runPlan(p, CFG, io);
    equal(spawn.calls.length, 6);
    ok(spawn.gauge.max <= 2, `max parallel was ${spawn.gauge.max}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failure blocks dependents transitively; independent branch completes", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => promptOf(call) === "do bad" ? { exit: 1, output: "boom" } : {});
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("bad", { prompt: "do bad" }),
      task("child", { after: ["bad"] }),
      task("grandchild", { after: ["child"] }),
      task("indep"),
    ]);
    const r = await runPlan(p, CFG, io);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.bad, "failed");
    equal(states.child, "blocked");
    equal(states.grandchild, "blocked");
    equal(states.indep, "ok");
    deepEqual(r.summary.blocked.sort(), ["child", "grandchild"]);
    // blocked tasks never spawned
    equal(spawn.calls.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rate-limit-shaped failure classified 'rate-limited'", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ exit: 1, output: "429 Too Many Requests: rate limit exceeded" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a")]);
    const r = await runPlan(p, CFG, io);
    equal(r.summary.tasks[0].state, "rate-limited");
    ok(io.snapshots.at(-1).includes("[rate-limited]"), io.snapshots.at(-1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyFailure matrix", () => {
  equal(classifyFailure({ timedOut: true, output: "" }), "failed:timeout");
  equal(classifyFailure({ timedOut: false, output: "HTTP 429" }), "rate-limited");
  equal(classifyFailure({ timedOut: false, output: "You hit a rate limit" }), "rate-limited");
  equal(classifyFailure({ timedOut: false, output: "too many requests" }), "rate-limited");
  equal(classifyFailure({ timedOut: false, output: "segfault" }), "failed");
  // quota outranks rate-limit: exhaustion is temporal, not transient
  equal(classifyFailure({ timedOut: false, output: "Claude AI usage limit reached|1751210400" }), "quota");
  equal(classifyFailure({ timedOut: false, output: "You've hit your limit; rate limit? no — resets at 3pm" }), "quota");
});

// Verbatim from land-two-plans-1/results/review-turn.log, 2026-09-06. The 429 makes
// RATE_LIMIT_RE match, so an unrecognised body is retried — 2 swarm retries on top of
// the CLI's own 10 — against a meter that cannot clear for hours.
const OLLAMA_WEEKLY_429 = "API Error: Request rejected (429) · you (someone) have reached your weekly usage limit, add extra usage: https://ollama.com/settings";
const OLLAMA_SESSION_429 = "API Error: Request rejected (429) · you (someone) have reached your session usage limit, add extra usage: https://ollama.com/settings";

test("classifyFailure: an ollama meter 429 is quota, not rate-limited", () => {
  equal(classifyFailure({ timedOut: false, output: OLLAMA_WEEKLY_429 }), "quota");
  equal(classifyFailure({ timedOut: false, output: OLLAMA_SESSION_429 }), "quota");
});

test("classifyFailure: ollama detection survives an overridden quotaPatterns", () => {
  // quotaPatterns is the Anthropic-tunable list. A user who narrows it for their own
  // account must not silently lose provider detection — which is also what reaches an
  // install whose config.json already holds the old four patterns, since `config init`
  // never overwrites a value that is already set.
  equal(classifyFailure({ timedOut: false, output: OLLAMA_WEEKLY_429 }, ["something else"]), "quota");
});

// SIGNOFF-1: the valve's reduce() had no initial value — an empty filter result
// (running ids present but none reads state "running") threw instead of no-op'ing.
test("pickNewestRunning: no id currently reads 'running' -> undefined, no throw", () => {
  const state = new Map([["a", "retrying"], ["b", "ok"]]);
  const startedAt = new Map([["a", 10], ["b", 20]]);
  equal(pickNewestRunning(["a", "b"], state, startedAt, new Map()), undefined);
});

test("pickNewestRunning: picks the later-started running id", () => {
  const state = new Map([["a", "running"], ["b", "running"]]);
  const startedAt = new Map([["a", 10], ["b", 20]]);
  const children = new Map([
    ["a", { exitCode: null, signalCode: null }],
    ["b", { exitCode: null, signalCode: null }],
  ]);
  equal(pickNewestRunning(["a", "b"], state, startedAt, children), "b");
});

// VALVE RACE: `state` stays "running" until the terminal record() call, which
// lands after settle() → enforceLeafContract → collect() → writeResult — a leaf
// whose child has already exited (settle ran, record() hasn't caught up) must
// never be the valve's pick just because `state` hasn't caught up yet.
test("pickNewestRunning: a dead child is skipped even though its state still reads 'running'", () => {
  const state = new Map([["a", "running"], ["b", "running"]]);
  const startedAt = new Map([["a", 10], ["b", 20]]); // b started later...
  const children = new Map([
    ["a", { exitCode: null, signalCode: null }],   // a: genuinely still alive
    ["b", { exitCode: 0, signalCode: null }],       // b: already exited ok
  ]);
  equal(pickNewestRunning(["a", "b"], state, startedAt, children), "a");
});

test("retry: rate-limited leaf retries with backoff and succeeds; dependents unharmed", async () => {
  const dir = tmp();
  try {
    let calls = 0;
    const spawn = fakeSpawnFactory(() => (++calls < 3 ? { exit: 1, output: "429 rate limit" } : { output: "recovered" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("flaky"), task("child", { after: ["flaky"] })]);
    const r = await runPlan(p, { ...CFG, retry: { rateLimited: 2, backoffMs: 20 } }, io);
    equal(calls, 4); // flaky x3 + child x1
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.flaky, "ok");
    equal(states.child, "ok");
    ok(io.snapshots.some((s) => s.includes("↻ retry")), "retrying visible in roster");
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ok(logLines.some((l) => l.id === "flaky" && l.state === "retrying"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retry: exhausted retries land as rate-limited terminal state", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ exit: 1, output: "429 rate limit" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("doomed")]);
    const r = await runPlan(p, { ...CFG, retry: { rateLimited: 2, backoffMs: 10 } }, io);
    equal(spawn.calls.length, 3); // initial + 2 retries
    equal(r.summary.tasks[0].state, "rate-limited");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retry: backoff park with nothing else running keeps the process alive (exit-13 regression)", async () => {
  const dir = tmp();
  try {
    const fixture = fileURLToPath(new URL("./helpers/backoff-park-child.mjs", import.meta.url));
    const child = nodeSpawn(process.execPath, [fixture, dir], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    equal(code, 0, `engine child exited ${code}; stderr: ${err.slice(0, 300)}`);
    deepEqual(JSON.parse(out), { flaky: "ok" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// errorCode/ENAMETOOLONG: a spawn error whose e.code is a deterministic argv-size
// failure must never burn a retry attempt on a leaf that will fail identically.
