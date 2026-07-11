import { test } from "node:test";
import { equal, deepEqual, ok, rejects } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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
    deepEqual(logLines[0].tasks, [
      { id: "a", model: "haiku" }, { id: "b", model: "haiku" }, { id: "c", model: "haiku" },
    ]);
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

test("fallback: quota leaf re-dispatches immediately on its declared fallbackModel", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      call.args[call.args.indexOf("--model") + 1] === "sonnet"
        ? { exit: 1, output: "Claude AI usage limit reached|1751210400" }
        : { output: "fallback did it" });
    const io = makeIo(spawn);
    const p = plan(dir, [task("judge", { model: "sonnet", fallbackModel: "haiku" })]);
    const r = await runPlan(p, { ...CFG, retry: { backoffMs: 10 } }, io);
    equal(spawn.calls.length, 2);
    equal(spawn.calls[1].args[spawn.calls[1].args.indexOf("--model") + 1], "haiku");
    equal(r.summary.tasks[0].state, "ok");
    equal(readResult(p.resultsDir, "judge").output, "fallback did it");
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const fb = logLines.find((l) => l.event === "fallback");
    deepEqual({ from: fb.from, to: fb.to }, { from: "sonnet", to: "haiku" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quota fail-fast: first Claude quota pre-emptively marks pending Claude leaves without fallback", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ exit: 1, output: "usage limit reached — resets at 3pm" }));
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("first", { model: "sonnet" }),
      task("second", { model: "haiku" }),
      task("saved", { model: "opus", fallbackModel: "haiku" }),
    ], { concurrency: 1 });
    const r = await runPlan(p, CFG, io);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.first, "quota");
    equal(states.second, "quota"); // never dispatched
    // 'saved' has a fallback: it dispatches on the fallback (also quota here, but it tried)
    ok(spawn.calls.length <= 3, `second must not burn a dispatch (got ${spawn.calls.length})`);
    const res = readResult(p.resultsDir, "first");
    equal(res.quotaResetsAt, "3pm");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight: exhausted quota aborts before dispatch when Claude leaves lack fallbacks", async () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "creds.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t" } }));
    const usage = { limits: [{ kind: "session", percent: 100, resets_at: "2026-07-11T15:00:00Z", severity: "exceeded" }] };
    const spawn = fakeSpawnFactory(() => ({ output: "never" }));
    const io = makeIo(spawn, {
      fetch: async () => ({ ok: true, status: 200, json: async () => usage }),
      env: { PATH: process.env.PATH, SWARM_HOME: home, SWARM_CREDENTIALS: join(home, "creds.json") },
    });
    const p = plan(dir, [task("c", { model: "sonnet" })]);
    await rejects(() => runPlan(p, CFG, io), /usage exhausted|cannot dispatch/i);
    equal(spawn.calls.length, 0);

    // 80%+ warns but proceeds — fresh SWARM_HOME so the cached 100% verdict
    // from the first half doesn't shadow the new endpoint response
    const home2 = join(dir, "home2");
    mkdirSync(home2, { recursive: true });
    const usage80 = { limits: [{ kind: "session", percent: 85, resets_at: "2026-07-11T15:00:00Z", severity: "warning" }] };
    const io2 = makeIo(fakeSpawnFactory(() => ({ output: "fine" })), {
      fetch: async () => ({ ok: true, status: 200, json: async () => usage80 }),
      env: { PATH: process.env.PATH, SWARM_HOME: home2, SWARM_CREDENTIALS: join(home, "creds.json") },
    });
    const p2 = plan(dir, [task("c2", { model: "sonnet" })], { resultsDir: join(dir, "run2") });
    const r2 = await runPlan(p2, CFG, io2);
    equal(r2.summary.tasks[0].state, "ok");
    ok(io2.lines.some((l) => l.includes("85%")), io2.lines.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    writeResult(p.resultsDir, "a", {
      id: "a", model: "haiku", ok: true, exit: 0, durationMs: 5, output: "prior-a",
      tokens: { input: 500, output: 40, cacheCreation: 0, cacheRead: 0 },
    });

    const spawn1 = fakeSpawnFactory(() => ({ output: "fresh" }));
    const io1 = makeIo(spawn1);
    const r1 = await runPlan(p, CFG, io1);
    equal(spawn1.calls.length, 1); // only b ran
    equal(promptOf(spawn1.calls[0]), "use prior-a"); // skipped dep still feeds templates
    const states1 = Object.fromEntries(r1.summary.tasks.map((t) => [t.id, t.state]));
    equal(states1.a, "skipped");
    equal(states1.b, "ok");
    // a skipped leaf's prior tokens still count in the summary
    deepEqual(r1.summary.tasks.find((t) => t.id === "a").tokens, { input: 500, output: 40, cacheCreation: 0, cacheRead: 0 });

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

test("stdout contract: roster snapshots per state change, never raw output", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "SECRET-RAW-OUTPUT" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a"), task("b")]);
    await runPlan(p, CFG, io);
    equal(io.lines.length, 0); // the engine paints snapshots; the CLI owns the closing block
    ok(io.snapshots.length >= 3, `one paint per state change, got ${io.snapshots.length}`);
    const last = io.snapshots.at(-1);
    ok(/✓ {2}a\s+haiku/.test(last), last);
    ok(/✓ {2}b\s+haiku/.test(last), last);
    ok(last.includes("2 ok"), last);
    ok(last.startsWith("swarm · run · 2 tasks"), last);
    ok(!io.snapshots.some((s) => s.includes("SECRET-RAW-OUTPUT")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stream-json leaf: result text extracted, tokens accounted end-to-end", async () => {
  const dir = tmp();
  try {
    const streamOut = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-abc" }),
      JSON.stringify({ type: "assistant", message: { id: "m1", usage: { input_tokens: 1000, output_tokens: 50 } } }),
      JSON.stringify({ type: "assistant", message: { id: "m2", usage: { input_tokens: 2000, output_tokens: 150, cache_read_input_tokens: 500 } } }),
      JSON.stringify({
        type: "result", subtype: "success", is_error: false, result: "the extracted answer",
        usage: { input_tokens: 3000, output_tokens: 200, cache_read_input_tokens: 500 },
        total_cost_usd: 0.05, num_turns: 2,
      }),
    ].join("\n") + "\n";
    const spawn = fakeSpawnFactory(() => ({ output: streamOut }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("leaf")]);
    const r = await runPlan(p, CFG, io);

    const res = readResult(p.resultsDir, "leaf");
    equal(res.output, "the extracted answer");
    deepEqual(res.tokens, { input: 3000, output: 200, cacheCreation: 0, cacheRead: 500 });
    equal(res.costUsd, 0.05);
    equal(res.numTurns, 2);
    // interrogation fields: session to resume, where, and with which tools
    equal(res.sessionId, "s-abc");
    equal(res.cwd, tmpdir());
    equal(res.originalCwd, tmpdir()); // pre-redirect cwd — the governance identity
    equal(res.allowedTools, "Read,Grep,Glob");

    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ok(logLines.some((l) => l.event === "tokens" && l.id === "leaf"), "expected a live tokens event in run.log");
    const done = logLines.find((l) => l.id === "leaf" && l.state === "ok");
    equal(done.tokens.input, 3000);
    ok(done.durationMs != null, "terminal run.log line carries durationMs");

    deepEqual(r.summary.tasks[0].tokens, { input: 3000, output: 200, cacheCreation: 0, cacheRead: 500 });
    deepEqual(r.summary.totalTokens, { input: 3000, output: 200, cacheCreation: 0, cacheRead: 500 });

    // final roster row shows 3000+200 work tokens = 3.2k; raw text never leaks
    ok(io.snapshots.some((s) => /leaf.*3\.2k/.test(s)), io.snapshots.at(-1));
    ok(!io.snapshots.some((s) => s.includes("extracted answer")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stream-json leaf: is_error result fails the task even on exit 0", async () => {
  const dir = tmp();
  try {
    const streamOut = JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "it broke" }) + "\n";
    const spawn = fakeSpawnFactory(() => ({ output: streamOut, exit: 0 }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("leaf")]);
    const r = await runPlan(p, CFG, io);
    equal(r.summary.tasks[0].state, "failed");
    equal(readResult(p.resultsDir, "leaf").ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activity: tool_use events reach run.log and the mid-run roster", async () => {
  const dir = tmp();
  try {
    const streamOut = [
      JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", name: "Grep", input: { path: "src/auth" } }], usage: { input_tokens: 100, output_tokens: 10 } } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "found it" }),
    ].join("\n") + "\n";
    // output at 50ms, close at 350ms — heartbeats in between paint the activity
    const spawn = fakeSpawnFactory(() => ({ output: streamOut, outputAtMs: 50, delayMs: 350 }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("leaf")]);
    await runPlan(p, { ...CFG, heartbeatSecs: 0.05 }, io);

    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const act = logLines.find((l) => l.event === "activity" && l.id === "leaf");
    equal(act.activity, "Grep src/auth");
    ok(io.snapshots.some((s) => /◐ {2}leaf.*Grep src\/auth/.test(s)), "mid-run snapshot should show activity");
    ok(!/Grep src\/auth/.test(io.snapshots.at(-1)), "terminal snapshot must not carry activity");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activity: a leaf with no stream events goes ⚠ quiet after quietWarnSecs", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "plain text at the end", delayMs: 350 }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("mute")]);
    await runPlan(p, { ...CFG, heartbeatSecs: 0.05, quietWarnSecs: 0.1 }, io);
    ok(io.snapshots.some((s) => /◐ {2}mute.*⚠ quiet \d+s/.test(s)), `expected a quiet warning:\n${io.snapshots.at(-2)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("heartbeat repaints the roster with climbing elapsed while a leaf runs", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ delayMs: 300, output: "x" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("slow")]);
    await runPlan(p, { ...CFG, heartbeatSecs: 0.05 }, io);
    const runningPaints = io.snapshots.filter((s) => s.includes("◐")).length;
    ok(runningPaints >= 2, `expected ≥2 running snapshots, got ${runningPaints}`);
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
