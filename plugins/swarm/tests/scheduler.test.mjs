import { test } from "node:test";
import { equal, deepEqual, ok, rejects } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn } from "node:child_process";
import { runPlan, substituteTemplates, classifyFailure } from "../src/scheduler.mjs";
import { writeResult, readResult, initResultsDir, resultPath } from "../src/results.mjs";
import { DIGEST_ID } from "../src/digest.mjs";
import { fakeSpawnFactory, makeIo, promptOf } from "./helpers/fake-io.mjs";

const SHIM = fileURLToPath(new URL("./shims/claude-shim.mjs", import.meta.url));

const CFG = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "ollama", allowedRoots: [] },
  concurrency: 4,
  timeoutMs: 600000,
  resultInlineCap: 4000,
  worktreeBranchPrefix: "swarm/",
};

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-sched-"));
}

function task(id, over = {}) {
  return {
    id,
    prompt: `do ${id}`,
    model: "haiku",
    allowedTools: "Read,Grep,Glob",
    cwd: over.cwd || tmpdir(),
    originalCwd: over.cwd || tmpdir(),
    scratchRedirect: false,
    timeoutMs: 5000,
    after: [],
    ...over,
  };
}

function plan(dir, tasks, over = {}) {
  return { cwd: dir, resultsDir: join(dir, "run"), concurrency: 4, tasks, goal: "", ...over };
}

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
    deepEqual(logLines[0].tasks, ["a", "b", "c"]);
    ok(existsSync(join(p.resultsDir, ".gitignore")));
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
    ok(io.lines.some((l) => l.includes("[rate-limited]")));
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
});

test("timeout kills the task -> failed:timeout (real shim)", async () => {
  const dir = tmp();
  try {
    const io = makeIo(
      (cmd, args, opts) => nodeSpawn(process.execPath, [SHIM, ...args], opts),
      { env: { ...process.env, SWARM_SHIM_SLEEP_MS: "10000" } },
    );
    const p = plan(dir, [task("slow", { timeoutMs: 400 })]);
    const r = await runPlan(p, CFG, io);
    equal(r.summary.tasks[0].state, "failed:timeout");
    equal(readResult(p.resultsDir, "slow").ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("template substitution feeds dependency results, inline capped", async () => {
  const dir = tmp();
  try {
    const big = "R".repeat(9000);
    const spawn = fakeSpawnFactory((call) => promptOf(call) === "produce" ? { output: big } : { output: "ok" });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src", { prompt: "produce" }),
      task("sink", { prompt: "got: {{result:src}} at {{resultPath:src}}", after: ["src"] }),
    ]);
    await runPlan(p, CFG, io);
    const sinkPrompt = promptOf(spawn.calls[1]);
    ok(sinkPrompt.startsWith("got: RRRR"));
    ok(sinkPrompt.includes(resultPath(p.resultsDir, "src")));
    // capped at resultInlineCap (4000), not the full 9000
    const inlined = sinkPrompt.match(/R+/)[0];
    equal(inlined.length, 4000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("substituteTemplates unit: path + cap", () => {
  const dir = tmp();
  try {
    initResultsDir(join(dir, "run"));
    writeResult(join(dir, "run"), "dep", { id: "dep", ok: true, output: "abcdef" });
    const out = substituteTemplates("x {{result:dep}} y {{resultPath:dep}}", join(dir, "run"), 3);
    equal(out, `x abc y ${resultPath(join(dir, "run"), "dep")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume skips ok results; --force reruns everything", async () => {
  const dir = tmp();
  try {
    const p = plan(dir, [task("a"), task("b", { prompt: "use {{result:a}}", after: ["a"] })]);
    initResultsDir(p.resultsDir);
    writeResult(p.resultsDir, "a", { id: "a", model: "haiku", ok: true, exit: 0, durationMs: 5, output: "prior-a" });

    const spawn1 = fakeSpawnFactory(() => ({ output: "fresh" }));
    const io1 = makeIo(spawn1);
    const r1 = await runPlan(p, CFG, io1);
    equal(spawn1.calls.length, 1); // only b ran
    equal(promptOf(spawn1.calls[0]), "use prior-a"); // skipped dep still feeds templates
    const states1 = Object.fromEntries(r1.summary.tasks.map((t) => [t.id, t.state]));
    equal(states1.a, "skipped");
    equal(states1.b, "ok");

    const spawn2 = fakeSpawnFactory(() => ({ output: "fresh" }));
    const io2 = makeIo(spawn2);
    await runPlan(p, CFG, io2, { force: true });
    equal(spawn2.calls.length, 2); // both reran
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume does NOT skip failed or rate-limited results", async () => {
  const dir = tmp();
  try {
    const p = plan(dir, [task("a")]);
    initResultsDir(p.resultsDir);
    writeResult(p.resultsDir, "a", { id: "a", model: "haiku", ok: false, exit: 1, output: "rate limit" });
    const spawn = fakeSpawnFactory(() => ({ output: "recovered" }));
    const r = await runPlan(p, CFG, makeIo(spawn));
    equal(spawn.calls.length, 1);
    equal(r.summary.tasks[0].state, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest: synthesized last, engine writes digest.md from leaf output", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      promptOf(call).includes("digest stage") ? { output: "# The Digest\nheadlines" } : { output: "leaf" });
    const io = makeIo(spawn);
    const p = plan(dir, [task("a"), task("b")], { digest: { model: "haiku", instructions: "" } });
    const r = await runPlan(p, CFG, io);
    equal(spawn.calls.length, 3);
    const digestCall = spawn.calls[2];
    ok(promptOf(digestCall).includes("digest stage")); // ran after all leaves
    equal(r.digestPath, join(p.resultsDir, "digest.md"));
    equal(readFileSync(r.digestPath, "utf8"), "# The Digest\nheadlines\n");
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states[DIGEST_ID], "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest failure: run completes, digestFailed flagged, no digest.md", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      promptOf(call).includes("digest stage") ? { exit: 1, output: "digest broke" } : { output: "leaf" });
    const io = makeIo(spawn);
    const p = plan(dir, [task("a")], { digest: { model: "haiku" } });
    const r = await runPlan(p, CFG, io);
    equal(r.digestFailed, true);
    equal(r.digestPath, null);
    ok(!existsSync(join(p.resultsDir, "digest.md")));
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.a, "ok"); // leaf results unaffected
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("health check: open-model plan fails fast when provider unreachable; claude-only never checks", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({}));
    let fetched = 0;
    const ioDown = makeIo(spawn, { fetch: async () => { fetched++; throw new Error("ECONNREFUSED"); } });
    const cfgAllowed = { ...CFG, provider: { ...CFG.provider, allowedRoots: [tmpdir()] } };
    const openPlan = plan(dir, [task("o", { model: "glm-4.6:cloud" })]);
    await rejects(() => runPlan(openPlan, cfgAllowed, ioDown), /unreachable/);
    equal(fetched, 1);
    equal(spawn.calls.length, 0); // nothing dispatched

    const ioNever = makeIo(spawn, { fetch: async () => { throw new Error("should not be called"); } });
    const claudePlan = plan(dir, [task("c")], { resultsDir: join(dir, "run2") });
    await runPlan(claudePlan, CFG, ioNever); // does not throw
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("open-model dispatch passes env trio through real spawn (shim log)", async () => {
  const dir = tmp();
  try {
    const shimLog = join(dir, "shim.log");
    const io = makeIo(
      (cmd, args, opts) => nodeSpawn(process.execPath, [SHIM, ...args], opts),
      { env: { ...process.env, SWARM_SHIM_LOG: shimLog, SWARM_SHIM_OUTPUT: "open-leaf-done" } },
    );
    const cfgAllowed = { ...CFG, provider: { ...CFG.provider, allowedRoots: [tmpdir()], url: "http://127.0.0.1:65500" } };
    const workCwd = mkdtempSync(join(tmpdir(), "swarm-cwd-"));
    const p = plan(dir, [task("o", { model: "minimax-m3:cloud", cwd: workCwd })]);
    const r = await runPlan(p, cfgAllowed, io);
    const entry = JSON.parse(readFileSync(shimLog, "utf8").trim());
    equal(entry.env.ANTHROPIC_MODEL, "minimax-m3:cloud");
    equal(entry.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:65500");
    equal(entry.env.ANTHROPIC_API_KEY, "ollama");
    deepEqual(entry.argv.slice(0, 2), ["-p", "do o"]);
    ok(entry.cwd.toLowerCase().startsWith(workCwd.toLowerCase().slice(0, 8)));
    equal(readResult(p.resultsDir, "o").output, "open-leaf-done");
    equal(r.summary.tasks[0].state, "ok");
    rmSync(workCwd, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scratch-redirected task gets its cwd created before spawn", async () => {
  const dir = tmp();
  try {
    let seenCwd;
    const spawn = fakeSpawnFactory((call) => { seenCwd = call.opts.cwd; return {}; });
    const io = makeIo(spawn);
    const scratch = join(dir, "run", "scratch-gen");
    const p = plan(dir, [task("gen", { cwd: scratch, scratchRedirect: true, allowedTools: "Write" })]);
    await runPlan(p, CFG, io);
    equal(seenCwd, scratch);
    ok(existsSync(scratch));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stdout contract: one status line per task, never raw output", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "SECRET-RAW-OUTPUT" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a"), task("b")]);
    await runPlan(p, CFG, io);
    equal(io.lines.length, 2);
    ok(io.lines.every((l) => /^✓ (a|b) haiku \d+s$/.test(l)), io.lines.join("|"));
    ok(!io.lines.some((l) => l.includes("SECRET-RAW-OUTPUT")));
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

test("JSON leaf output is parsed into outputJson alongside raw", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '{"verdict":"pass","score":9}' }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("judge")]);
    await runPlan(p, CFG, io);
    const res = readResult(p.resultsDir, "judge");
    equal(res.output, '{"verdict":"pass","score":9}');
    deepEqual(res.outputJson, { verdict: "pass", score: 9 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
