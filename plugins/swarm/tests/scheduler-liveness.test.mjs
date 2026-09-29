import { test } from "node:test";
import { equal, deepEqual, ok, rejects, match } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { oracleSnapKey } from "./helpers/snap-key.mjs";
import { runPlan, runTask, substituteTemplates, substituteItems, classifyFailure, pickNewestRunning } from "../src/scheduler.mjs";
import { writeResult, readResult, initResultsDir, resultPath, writeDigestMd, writeSummary, readHeartbeat, stopPath } from "../src/results.mjs";
import { DIGEST_ID } from "../src/digest.mjs";
import { CFG, tmp, task, plan, computeTask, childPlanOf, fakeSpawnFactory, makeIo, promptOf, sentPrompt, usageEnv, codexReading, SHIM, streamOut, gitInRepo, initGitRepo, commitAllInRepo, fakeWorktree, buildStrandPlan, integrateLeaf, forEachFixLeaf, fixCloneTasks } from "./helpers/scheduler-fixtures.mjs";
// ── memory survivability (D3/D4/D5/D6) ──────────────────────────────────────

test("M1/M2/M5: spawn floor parks a leaf that would exceed it while another runs, costs no attempt, and never gates the one nothing else is running against", async () => {
  const dir = tmp();
  try {
    let n = 0;
    const freeMemMb = () => (++n <= 1 ? 500 : 99999); // low only for the park check itself
    const spawn = fakeSpawnFactory(() => ({ output: "done" }));
    const io = makeIo(spawn, { freeMemMb });
    const p = plan(dir, [task("a"), task("b")]);
    const r = await runPlan(p, { ...CFG, minFreeMemMb: 2048, heartbeatSecs: 0.05 }, io);

    equal(spawn.calls.length, 2, "b parked once, never double-dispatched — no attempt spent parking"); // M5
    deepEqual(r.summary.tasks.map((t) => t.state), ["ok", "ok"]);

    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const iA_ok = logLines.findIndex((l) => l.id === "a" && l.state === "ok");
    const iB_retrying = logLines.findIndex((l) => l.id === "b" && l.state === "retrying");
    const iA_running = logLines.findIndex((l) => l.id === "a" && l.state === "running");
    ok(iB_retrying >= 0, "b must have been parked");
    ok(iA_running >= 0 && iA_running < iB_retrying, "a was already running when b parked"); // M1
    ok(iB_retrying < iA_ok, "b parked before a's own run finished"); // M1

    ok(io.snapshots.some((s) => s.includes("⏸ low memory")), "roster must show the park note"); // M1
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M2: the only task in the plan launches immediately even with memory already below the floor", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "done" }));
    const io = makeIo(spawn, { freeMemMb: () => 1 }); // permanently starved
    const p = plan(dir, [task("solo")]);
    const r = await runPlan(p, { ...CFG, minFreeMemMb: 2048 }, io);

    equal(spawn.calls.length, 1, "the only leaf must not be gated by the floor when nothing else runs");
    equal(r.summary.tasks[0].state, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M3: a memory-parked leaf resumes without a per-park timer — real-subprocess liveness regression", async () => {
  const dir = tmp();
  try {
    const fixture = fileURLToPath(new URL("./helpers/memory-park-child.mjs", import.meta.url));
    const child = nodeSpawn(process.execPath, [fixture, dir], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    equal(code, 0, `engine child exited ${code}; stderr: ${err.slice(0, 300)}`);
    deepEqual(JSON.parse(out), { a: "ok", b: "ok" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M4: the valve kills the newest running leaf under the low-memory floor, and the redrive resumes its session", async () => {
  const dir = tmp();
  try {
    let nowN = 0;
    let memN = 0;
    let bCalls = 0;
    const freeMemMb = () => (++memN === 2 ? 500 : 99999); // low only at the valve's first check
    const spawn = fakeSpawnFactory((call) => {
      const p = promptOf(call);
      if (p === "do a") return { output: "a done", delayMs: 300 };
      bCalls++;
      if (bCalls === 1) {
        return {
          // init + a mid-response assistant chunk (no stop_reason yet): a
          // genuine "died mid-stream" shape, so the valve's kill must be
          // distinguished from that via memoryStopped, not from this text.
          output: [
            JSON.stringify({ type: "system", subtype: "init", session_id: "s-b1" }),
            JSON.stringify({ type: "assistant", message: { id: "m1" } }),
          ].join("\n") + "\n",
          outputAtMs: 5,
          delayMs: 3000, // bounded: without the valve this leaf still ends, giving RED a real (not hung) failure
        };
      }
      return { output: "b done", delayMs: 10 };
    });
    const io = makeIo(spawn, { freeMemMb, now: () => (nowN += 10) });
    const p = plan(dir, [task("a"), task("b")]);
    const cfg = { ...CFG, minFreeMemMb: 2048, valveFreeMemMb: 1024, heartbeatSecs: 0.05 };

    const peek = new Promise((resolve) => {
      setTimeout(() => resolve(readResult(p.resultsDir, "b")), 150);
    });
    const [r, midB] = await Promise.all([runPlan(p, cfg, io), peek]);

    ok(midB, "expected an interim (killed) result for b before it resumed");
    equal(midB.ok, false);
    equal(midB.sessionId, "s-b1");
    ok(midB.output.includes("low memory"), midB.output);
    ok(!midB.output.includes("do not kill or diff-hunt"), midB.output);

    equal(bCalls, 2, "b: one killed attempt, one resumed attempt");
    const ri = spawn.calls.findIndex((c, i) => i > 0 && promptOf(c) === "do b" && c.args.includes("--resume"));
    ok(ri >= 0, "the resumed spawn for b must carry --resume");
    equal(spawn.calls[ri].args[spawn.calls[ri].args.indexOf("--resume") + 1], "s-b1");

    deepEqual(r.summary.tasks.map((t) => t.state), ["ok", "ok"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// M5: a memory park must never consume a retry attempt. The independent "b"
// leaf is shallower than the decoy chain, so wave-first seating gives it the
// first free seat after one valve kill. With retry.spawnError: 0, any attempt
// spent on that park would leave b terminal instead of finishing cleanly.
test("M5: a valve-killed leaf with a zero retry budget still finishes after a park", async () => {
  const dir = tmp();
  try {
    let nowN = 0;
    const spawn = fakeSpawnFactory((call) => (
      promptOf(call) === "do b" ? { output: "b done", delayMs: 300 } : { output: "done", delayMs: 150 }
    ));
    const io = makeIo(spawn, { freeMemMb: () => 1, now: () => (nowN += 10) }); // permanently starved
    const p = plan(dir, [
      task("d1"),
      task("d2", { after: ["d1"] }),
      task("d3", { after: ["d2"] }),
      task("b"),
    ], { concurrency: 2 });
    const cfg = { ...CFG, concurrency: 2, minFreeMemMb: 0, valveFreeMemMb: 2048, heartbeatSecs: 0.05, retry: { spawnError: 0 } };
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("runPlan hung waiting on b's parks")), 5000));
    const r = await Promise.race([runPlan(p, cfg, io), timeout]);

    equal(spawn.calls.filter((c) => promptOf(c) === "do b").length, 2, "1 killed attempt + 1 clean finish");
    deepEqual(r.summary.tasks.map((t) => t.state), ["ok", "ok", "ok", "ok"]);

    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const bParks = logLines.filter((l) => l.id === "b" && l.state === "retrying" && l.note === "memory-park");
    equal(bParks.length, 1, "b must have been parked for memory exactly once, never as a retry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("liveness: a stop file kills every tracked child, writes the summary exactly once, marks leaves failed:stopped", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ delayMs: 10000, output: "x" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", { timeoutMs: 60000 }), task("b", { timeoutMs: 60000 })]);
    let writeSummaryCalls = 0;
    const _writeSummary = (resultsDir, summary) => { writeSummaryCalls++; return writeSummary(resultsDir, summary); };
    const runPromise = runPlan(p, { ...CFG, heartbeatSecs: 0.05, concurrency: 2 }, io, { _writeSummary });
    // resultsDir is created synchronously before runPlan's first await — safe to write here
    writeFileSync(stopPath(p.resultsDir), "");
    const r = await runPromise;

    equal(r.summary.stopped, true);
    ok(r.summary.stopReason, "summary must name why the run stopped");
    equal(r.summary.tasks.find((t) => t.id === "a").state, "failed:stopped");
    equal(r.summary.tasks.find((t) => t.id === "b").state, "failed:stopped");
    equal(writeSummaryCalls, 1, "exactly one summary write for the whole run, stop included");

    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ok(logLines.some((l) => l.event === "run-stop"), "run-stop must be appended to run.log");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: a stop file leftover from a prior `swarm stop` is cleared on start, so the run is not immediately stopped", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ delayMs: 300, output: "x" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("leaf", { timeoutMs: 60000 })]);
    initResultsDir(p.resultsDir);
    writeFileSync(stopPath(p.resultsDir), "");

    const r = await runPlan(p, { ...CFG, heartbeatSecs: 0.05 }, io);

    equal(r.summary.tasks.find((t) => t.id === "leaf").state, "ok");
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ok(!logLines.some((l) => l.event === "run-stop"), "a leftover stop file must not stop a fresh engine");
    ok(!existsSync(stopPath(p.resultsDir)), "the leftover stop file must be removed on start");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("liveness: SIGINT routes through requestStop and stops the run", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ delayMs: 10000, output: "x" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("leaf", { timeoutMs: 60000 })]);
    const before = process.listenerCount("SIGINT");
    const runPromise = runPlan(p, { ...CFG, heartbeatSecs: 0.05 }, io);
    process.emit("SIGINT");
    const r = await runPromise;
    equal(r.summary.stopped, true);
    equal(r.summary.tasks[0].state, "failed:stopped");
    equal(process.listenerCount("SIGINT"), before, "the run must remove its SIGINT handler on exit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGNOFF-2: stop wins over a leaf still parked for memory — the loop exit itself must fire, not a lucky redrive", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "x", delayMs: 10000 }));
    const io = makeIo(spawn, { freeMemMb: () => 1 }); // permanently starved
    const p = plan(dir, [task("a"), task("b")]);
    // heartbeatSecs long enough that the memory redrive (heartbeat-only) cannot
    // fire inside this test's timeout — b must still be genuinely parked when
    // stop lands, so only the loop-exit condition can end the run.
    const cfg = { ...CFG, minFreeMemMb: 2048, concurrency: 2, heartbeatSecs: 10 };
    const runPromise = runPlan(p, cfg, io);
    // signal, not the stop-file: detecting the file also needs a heartbeat tick.
    setTimeout(() => process.emit("SIGINT"), 50);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("runPlan hung: stop did not win over a memory-parked leaf")), 3000));
    const r = await Promise.race([runPromise, timeout]);

    equal(r.summary.stopped, true);
    equal(r.summary.tasks.find((t) => t.id === "a").state, "failed:stopped");
    equal(r.summary.tasks.find((t) => t.id === "b").state, "failed:stopped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGNOFF-3: memory never recovers — the redrive must still keep one leaf moving at a time", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "done", delayMs: 20 }));
    const io = makeIo(spawn, { freeMemMb: () => 1 }); // permanently starved, never recovers
    const p = plan(dir, [task("a"), task("b"), task("c")]);
    const cfg = { ...CFG, minFreeMemMb: 2048, concurrency: 3, heartbeatSecs: 0.05 };
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("runPlan stalled: no leaf ever re-drove under a permanently low memory floor")), 3000));
    const r = await Promise.race([runPlan(p, cfg, io), timeout]);

    equal(spawn.gauge.max, 1, "never more than one leaf running at once under the floor");
    for (const id of ["a", "b", "c"]) equal(r.summary.tasks.find((t) => t.id === id).state, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("per-leaf log streams progressively to results/<id>.log (real shim)", async () => {
  const dir = tmp();
  try {
    const io = makeIo(
      (cmd, args, opts) => nodeSpawn(process.execPath, [SHIM, ...args], opts),
      { env: { ...process.env, SWARM_SHIM_SLEEP_MS: "1200", SWARM_SHIM_OUTPUT: "tail-me" } },
    );
    const p = plan(dir, [task("slow", { timeoutMs: 10000 })]);
    const running = runPlan(p, CFG, io);

    // While the leaf is still sleeping, the log file already exists — it is a
    // write stream opened at spawn, not a buffer flushed at completion.
    const logPath = join(p.resultsDir, "results", "slow.log");
    const deadline = Date.now() + 1000;
    while (!existsSync(logPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    ok(existsSync(logPath), "leaf log should exist while the task is running");

    const r = await running;
    equal(r.summary.tasks[0].state, "ok");
    equal(readFileSync(logPath, "utf8"), "tail-me");
    equal(readResult(p.resultsDir, "slow").output, "tail-me"); // buffered copy intact
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── deterministic steps: compute / when / forEach ─────────────────────────────
