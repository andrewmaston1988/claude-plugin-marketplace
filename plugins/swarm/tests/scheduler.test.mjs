import { test } from "node:test";
import { equal, deepEqual, ok, rejects } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn } from "node:child_process";
import { runPlan, substituteTemplates, substituteItems, classifyFailure } from "../src/scheduler.mjs";
import { writeResult, readResult, initResultsDir, resultPath, writeDigestMd } from "../src/results.mjs";
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

test("returns-validation failure classifies failed, not rate-limited, despite 429-shaped transcript noise", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "src.txt"), "alpha\nbeta\n");
    const returns = {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: { file: { type: "string" }, line: { type: "integer" }, quote: { type: "string" } },
            required: ["file", "line", "quote"],
          },
        },
      },
      required: ["findings"],
    };
    // the refuted citation's line number IS the 429 — transcript grep would
    // misread this semantic failure as transient and burn full re-runs on it
    const spawn = fakeSpawnFactory(() => ({ output: '{"findings":[{"file":"src.txt","line":429,"quote":"does not appear"}]}' }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", { cwd: dir, returns })]);
    const r = await runPlan(p, { ...CFG, retry: { rateLimited: 2, backoffMs: 10 } }, io);
    equal(spawn.calls.length, 1, `semantic failure must not re-run as transient (got ${spawn.calls.length} dispatches)`);
    equal(r.summary.tasks[0].state, "failed");
    ok(readResult(p.resultsDir, "a").citationErrors?.length, "citationErrors recorded");
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

// A model-SCOPED bucket at 100% must ground ONLY that model. The account verdict
// comes from the unscoped buckets. Regression: a full Fable-scoped weekly bucket
// grounded every Claude leaf — Opus, Sonnet and Haiku — while the account had 46%
// headroom, and the session issuing the dispatch was itself running on Opus.
test("preflight: a scoped-bucket exhaustion grounds only that model's leaves", async () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "creds.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t" } }));
    // Fable's weekly bucket is full; session/weekly_all have headroom.
    const usage = { limits: [
      { kind: "session", percent: 24, resets_at: "R1", scope: null },
      { kind: "weekly_all", percent: 54, resets_at: "R2", scope: null },
      { kind: "weekly_scoped", percent: 100, resets_at: "R3", scope: { model: { display_name: "Fable" } } },
    ] };
    const mkIo = (h) => makeIo(fakeSpawnFactory(() => ({ output: "ok" })), {
      fetch: async () => ({ ok: true, status: 200, json: async () => usage }),
      env: { PATH: process.env.PATH, SWARM_HOME: h, SWARM_CREDENTIALS: join(home, "creds.json") },
    });

    // Sonnet/Opus/Haiku draw from the unscoped buckets → they must dispatch.
    const io1 = mkIo(home);
    const p1 = plan(dir, [task("s", { model: "sonnet" }), task("o", { model: "opus" }), task("h", { model: "haiku" })]);
    await runPlan(p1, CFG, io1);
    equal(io1.spawn.calls.length, 3, "non-scoped Claude models must still dispatch");

    // A Fable leaf IS constrained by the exhausted Fable bucket → still aborts.
    const home2 = join(dir, "home2");
    mkdirSync(home2, { recursive: true });
    const io2 = mkIo(home2);
    const p2 = plan(dir, [task("f", { model: "claude-fable-5" })]);
    await rejects(() => runPlan(p2, CFG, io2), /Fable-scoped limit is at 100%/i);
    equal(io2.spawn.calls.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The endpoint may name a scope "Claude Sonnet 4.5", not "Sonnet". Matching the
// leaf model against it by substring in one direction misses that entirely, so an
// exhausted Sonnet bucket would happily dispatch Sonnet leaves.
test("preflight: a multi-word scope name still matches its model family", async () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "creds.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t" } }));
    const usage = { limits: [
      { kind: "session", percent: 10, resets_at: "R1", scope: null },
      { kind: "weekly_scoped", percent: 100, resets_at: "R3", scope: { model: { display_name: "Claude Sonnet 4.5" } } },
    ] };
    const io = makeIo(fakeSpawnFactory(() => ({ output: "ok" })), {
      fetch: async () => ({ ok: true, status: 200, json: async () => usage }),
      env: { PATH: process.env.PATH, SWARM_HOME: home, SWARM_CREDENTIALS: join(home, "creds.json") },
    });
    await rejects(() => runPlan(plan(dir, [task("s", { model: "sonnet" })]), CFG, io), /Sonnet.*scoped limit/i);
    equal(io.spawn.calls.length, 0, "an exhausted Sonnet bucket must ground Sonnet leaves");
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

// The p5-review failure: find-deletions re-ran, but verify-deletions (which exists
// ONLY to check it) was skipped on its previous-pass `ok`, and __digest was skipped
// AND digest.md rewritten from the previous run's body. The run then reported success
// and handed the session a verdict that predated everything the resume produced.
// A cached result is only valid if every input that produced it is unchanged.
test("resume: a dependent whose upstream re-runs is invalidated, and the digest is not stale", async () => {
  const dir = tmp();
  try {
    const p = plan(dir, [
      task("find"),
      task("verify", { prompt: "check {{result:find}}", after: ["find"] }),
    ], { digest: { model: "haiku" } });
    initResultsDir(p.resultsDir);
    // prior pass: find FAILED, but verify and the digest succeeded against the
    // findings of a still-earlier pass.
    writeResult(p.resultsDir, "find", { id: "find", model: "haiku", ok: false, exit: 1, durationMs: 5, output: "boom" });
    writeResult(p.resultsDir, "verify", { id: "verify", model: "haiku", ok: true, exit: 0, durationMs: 5, output: "STALE-verdict" });
    writeResult(p.resultsDir, DIGEST_ID, { id: DIGEST_ID, model: "haiku", ok: true, exit: 0, durationMs: 5, output: "STALE-digest" });
    writeDigestMd(p.resultsDir, "STALE-digest");

    const spawn = fakeSpawnFactory((call) => {
      const pr = promptOf(call);
      if (pr === "do find") return { output: "NEW-findings" };
      if (pr.startsWith("check ")) return { output: "FRESH-verdict" };
      return { output: "FRESH-digest" };
    });
    const io = makeIo(spawn);
    const r = await runPlan(p, CFG, io);

    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.find, "ok", "find had no valid cache — must re-run");
    equal(states.verify, "ok", "verify's upstream re-ran — its cached verdict is stale");
    equal(states[DIGEST_ID], "ok", "the digest depends on everything — anything re-running invalidates it");

    // the verifier must have been fed the NEW findings, not the old ones
    ok(spawn.calls.map(promptOf).includes("check NEW-findings"), spawn.calls.map(promptOf).join(" | "));

    // and the artifact on disk must be this pass's digest, not the previous one
    equal(readFileSync(join(p.resultsDir, "digest.md"), "utf8").trim(), "FRESH-digest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Invalidation is transitive: A → B → C. If A re-runs, C is stale even though C
// never names A. One-hop invalidation would leave exactly the digest-shaped hole.
test("resume: invalidation is transitive across the dependency chain", async () => {
  const dir = tmp();
  try {
    const p = plan(dir, [
      task("a"),
      task("b", { prompt: "b uses {{result:a}}", after: ["a"] }),
      task("c", { prompt: "c uses {{result:b}}", after: ["b"] }),
    ]);
    initResultsDir(p.resultsDir);
    writeResult(p.resultsDir, "b", { id: "b", model: "haiku", ok: true, exit: 0, durationMs: 5, output: "old-b" });
    writeResult(p.resultsDir, "c", { id: "c", model: "haiku", ok: true, exit: 0, durationMs: 5, output: "old-c" });
    // a has no result at all → re-runs → b stale → c stale (c never mentions a)

    const spawn = fakeSpawnFactory(() => ({ output: "fresh" }));
    const io = makeIo(spawn);
    const r = await runPlan(p, CFG, io);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.a, "ok");
    equal(states.b, "ok", "b's upstream re-ran");
    equal(states.c, "ok", "c is two hops from a and must still be invalidated");
    equal(spawn.calls.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Resume must stay cheap: invalidation follows the graph, it does not nuke the run.
test("resume: an independent cached leaf is still skipped when an unrelated leaf re-runs", async () => {
  const dir = tmp();
  try {
    const p = plan(dir, [
      task("a"),
      task("b", { after: ["a"] }),
      task("d"), // independent of a and b
    ]);
    initResultsDir(p.resultsDir);
    writeResult(p.resultsDir, "d", { id: "d", model: "haiku", ok: true, exit: 0, durationMs: 5, output: "cached-d" });

    const spawn = fakeSpawnFactory(() => ({ output: "fresh" }));
    const io = makeIo(spawn);
    const r = await runPlan(p, CFG, io);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.d, "skipped", "d shares no dependency with the re-running leaves");
    equal(states.a, "ok");
    equal(states.b, "ok");
    equal(spawn.calls.length, 2, "only a and b dispatched");
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

// ── deterministic steps: compute / when / forEach ─────────────────────────────

function computeTask(id, expr, after) {
  return task(id, { compute: expr, model: "compute", prompt: "", allowedTools: "", after });
}

test("compute: runs inline with zero spawns; result feeds templates and JSON chains", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      promptOf(call) === "do src" ? { output: '{"sites":[{"f":"a"},{"f":"a"},{"f":"b"}]}' } : { output: "sunk" });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      computeTask("dedupe", "unique_by(deps['src'].sites, 'f')", ["src"]),
      task("sink", { prompt: "got {{result:dedupe}}", after: ["dedupe"] }),
    ]);
    const r = await runPlan(p, CFG, io);
    equal(spawn.calls.length, 2); // src + sink; dedupe never spawns
    const dd = readResult(p.resultsDir, "dedupe");
    equal(dd.ok, true);
    deepEqual(dd.outputJson, [{ f: "a" }, { f: "b" }]);
    equal(dd.output, '[{"f":"a"},{"f":"b"}]');
    equal(promptOf(spawn.calls[1]), 'got [{"f":"a"},{"f":"b"}]');
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    deepEqual(states, { src: "ok", dedupe: "ok", sink: "ok" });
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ok(logLines.some((l) => l.id === "dedupe" && l.state === "ok"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compute: a dependency with non-JSON output binds as a raw string", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "ERROR: kaboom" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("src"), computeTask("check", "contains(deps['src'], 'ERROR')", ["src"])]);
    await runPlan(p, CFG, io);
    const res = readResult(p.resultsDir, "check");
    equal(res.ok, true);
    equal(res.outputJson, true);
    equal(res.output, "true");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compute failure: teaching message lands in the result and blocks dependents", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '{"sites":[]}' }));
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      computeTask("dedupe", "length(deps.src.nope)", ["src"]),
      task("child", { after: ["dedupe"] }),
    ]);
    const r = await runPlan(p, CFG, io);
    const res = readResult(p.resultsDir, "dedupe");
    equal(res.ok, false);
    ok(res.output.startsWith("compute failed:"), res.output);
    ok(res.output.includes("length("), res.output);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.dedupe, "failed");
    equal(states.child, "blocked");
    deepEqual(r.summary.blocked, ["child"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when: false gate skips with a run.log note; dependents treat skipped as satisfied", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '{"sites":[1]}' }));
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("gate", { after: ["src"], when: { from: "src", expr: "length(value.sites) > 2" } }),
      task("child", { after: ["gate"] }),
    ]);
    const r = await runPlan(p, CFG, io);
    equal(spawn.calls.length, 2); // src + child; the gate never spawns
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.gate, "skipped");
    equal(states.child, "ok");
    equal(readResult(p.resultsDir, "gate"), null); // no result file — when re-evaluates on resume
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const skip = logLines.find((l) => l.id === "gate" && l.state === "skipped");
    ok(skip.note.includes("when:"), skip.note);
    ok(skip.note.includes("false"), skip.note);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when: true gate dispatches the leaf normally", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '{"sites":[1,2,3]}' }));
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("gate", { after: ["src"], when: { from: "src", expr: "length(value.sites) > 2" } }),
    ]);
    const r = await runPlan(p, CFG, io);
    equal(spawn.calls.length, 2);
    equal(r.summary.tasks.find((t) => t.id === "gate").state, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when: non-boolean and erroring expressions fail the task with the teaching message", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '{"sites":[1]}' }));
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("g1", { after: ["src"], when: { from: "src", expr: "value.sites" } }),
      task("g2", { after: ["src"], when: { from: "src", expr: "length(value.nope) > 0" } }),
    ]);
    const r = await runPlan(p, CFG, io);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.g1, "failed");
    equal(states.g2, "failed");
    ok(/true\/false/.test(readResult(p.resultsDir, "g1").output));
    ok(readResult(p.resultsDir, "g2").output.startsWith("when failed:"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: expands clones with {{item}}/{{index}}, parent aggregates for dependents (reverse declaration order)", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const pr = promptOf(call);
      if (pr === "do src") return { output: '{"sites":[{"f":"a"},{"f":"a"},{"f":"b"}]}' };
      if (pr.startsWith("fix ")) return { output: `done-${pr[4]}` };
      return { output: "sunk" };
    });
    const io = makeIo(spawn);
    // declared sink-first: settles that complete inline (compute, expansion,
    // aggregation) must re-drive the selection loop, not strand the chain
    const p = plan(dir, [
      task("sink", { prompt: "all: {{result:fix}}", after: ["fix"] }),
      task("fix", { after: ["dedupe"], forEach: { from: "dedupe", path: "", maxItems: 5 }, prompt: "fix {{item.f}} #{{index}}" }),
      computeTask("dedupe", "unique_by(deps['src'].sites, 'f')", ["src"]),
      task("src"),
    ]);
    const r = await runPlan(p, CFG, io);
    deepEqual(spawn.calls.map(promptOf), ["do src", "fix a #0", "fix b #1", 'all: ["done-a","done-b"]']);
    equal(readResult(p.resultsDir, "fix[0]").output, "done-a");
    equal(readResult(p.resultsDir, "fix[1]").output, "done-b");
    const parent = readResult(p.resultsDir, "fix");
    equal(parent.ok, true);
    deepEqual(parent.outputJson, ["done-a", "done-b"]);
    equal(parent.clones, 2);
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const expand = logLines.find((l) => l.event === "expand");
    deepEqual({ id: expand.id, clones: expand.clones, model: expand.model }, { id: "fix", clones: 2, model: "haiku" });
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    deepEqual(states, { src: "ok", dedupe: "ok", fix: "ok", "fix[0]": "ok", "fix[1]": "ok", sink: "ok" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: truncation is loud — result field, run.log, stdout warning, summary", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      promptOf(call) === "do src" ? { output: '{"sites":[{"f":"a"},{"f":"b"},{"f":"c"}]}' } : { output: "x" });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("fix", { after: ["src"], forEach: { from: "src", path: "sites", maxItems: 2 }, prompt: "fix {{item.f}}" }),
    ]);
    const r = await runPlan(p, CFG, io);
    equal(spawn.calls.length, 3); // src + 2 capped clones
    deepEqual(readResult(p.resultsDir, "fix").truncated, { kept: 2, total: 3 });
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const expand = logLines.find((l) => l.event === "expand");
    equal(expand.truncated, true);
    equal(expand.total, 3);
    ok(io.lines.some((l) => l.includes("first 2") && l.includes("3")), io.lines.join("|"));
    deepEqual(r.summary.truncations, [{ id: "fix", kept: 2, total: 3 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: an empty source array completes the parent with an empty aggregate", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      promptOf(call) === "do src" ? { output: '{"sites":[]}' } : { output: "sunk" });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("fix", { after: ["src"], forEach: { from: "src", path: "sites", maxItems: 5 }, prompt: "fix {{item}}" }),
      task("sink", { prompt: "all: {{result:fix}}", after: ["fix"] }),
    ]);
    const r = await runPlan(p, CFG, io);
    equal(spawn.calls.length, 2); // src + sink
    const parent = readResult(p.resultsDir, "fix");
    equal(parent.ok, true);
    deepEqual(parent.outputJson, []);
    equal(promptOf(spawn.calls[1]), "all: []");
    equal(r.summary.tasks.find((t) => t.id === "fix").state, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: a non-array selection fails the parent with a teaching message", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '{"sites":[1]}' }));
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("fix", { after: ["src"], forEach: { from: "src", path: "nope", maxItems: 5 }, prompt: "fix {{item}}" }),
      task("sink", { after: ["fix"] }),
    ]);
    const r = await runPlan(p, CFG, io);
    const res = readResult(p.resultsDir, "fix");
    equal(res.ok, false);
    ok(res.output.includes("expected a JSON array"), res.output);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.fix, "failed");
    equal(states.sink, "blocked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: a failed clone dooms the parent aggregate; sibling clones still finish", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const pr = promptOf(call);
      if (pr === "do src") return { output: '{"sites":[{"f":"a"},{"f":"b"}]}' };
      if (pr === "fix b") return { exit: 1, output: "clone broke" };
      return { output: "ok" };
    });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("fix", { after: ["src"], forEach: { from: "src", path: "sites", maxItems: 5 }, prompt: "fix {{item.f}}" }),
      task("sink", { after: ["fix"] }),
    ]);
    const r = await runPlan(p, CFG, io);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states["fix[0]"], "ok");
    equal(states["fix[1]"], "failed");
    equal(states.fix, "blocked");
    equal(states.sink, "blocked");
    equal(readResult(p.resultsDir, "fix"), null); // no aggregate written
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: clones inherit model and fallbackModel; fallback fires per clone", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      call.args[call.args.indexOf("--model") + 1] === "sonnet"
        ? { exit: 1, output: "Claude AI usage limit reached|1751210400" }
        : { output: promptOf(call) === "do src" ? '{"sites":[{"f":"a"}]}' : "recovered" });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("fix", {
        after: ["src"], forEach: { from: "src", path: "sites", maxItems: 5 },
        prompt: "fix {{item.f}}", model: "sonnet", fallbackModel: "haiku",
      }),
    ]);
    const r = await runPlan(p, { ...CFG, retry: { backoffMs: 10 } }, io);
    const cloneCalls = spawn.calls.filter((c) => promptOf(c) === "fix a");
    equal(cloneCalls.length, 2);
    equal(cloneCalls[0].args[cloneCalls[0].args.indexOf("--model") + 1], "sonnet");
    equal(cloneCalls[1].args[cloneCalls[1].args.indexOf("--model") + 1], "haiku");
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states["fix[0]"], "ok");
    equal(states.fix, "ok");
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const fb = logLines.find((l) => l.event === "fallback");
    equal(fb.id, "fix[0]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: item data containing template syntax stays literal in the clone prompt", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      promptOf(call) === "do src" ? { output: '{"sites":[{"f":"{{result:src}}"}]}' } : { output: "x" });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("fix", { after: ["src"], forEach: { from: "src", path: "sites", maxItems: 5 }, prompt: "fix {{item.f}}" }),
    ]);
    await runPlan(p, CFG, io);
    // the item value must NOT be re-substituted as a template at launch
    equal(promptOf(spawn.calls[1]), "fix {{result:src}}");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: resume skips clones with prior ok results", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "fresh" }));
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("fix", { after: ["src"], forEach: { from: "src", path: "sites", maxItems: 5 }, prompt: "fix {{item.f}}" }),
    ]);
    initResultsDir(p.resultsDir);
    writeResult(p.resultsDir, "src", { id: "src", model: "haiku", ok: true, exit: 0, durationMs: 5, output: '{"sites":[{"f":"a"},{"f":"b"}]}', outputJson: { sites: [{ f: "a" }, { f: "b" }] } });
    writeResult(p.resultsDir, "fix[0]", { id: "fix[0]", model: "haiku", ok: true, exit: 0, durationMs: 5, output: "prior" });
    const r = await runPlan(p, CFG, io);
    equal(spawn.calls.length, 1); // only fix[1]
    equal(promptOf(spawn.calls[0]), "fix b");
    deepEqual(readResult(p.resultsDir, "fix").outputJson, ["prior", "fresh"]);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states["fix[0]"], "skipped");
    equal(states["fix[1]"], "ok");
    equal(states.fix, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when + forEach: a false gate skips before any expansion", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      promptOf(call) === "do src" ? { output: '{"sites":[{"f":"a"}]}' } : { output: "sunk" });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("fix", {
        after: ["src"], when: { from: "src", expr: "length(value.sites) > 9" },
        forEach: { from: "src", path: "sites", maxItems: 5 }, prompt: "fix {{item.f}}",
      }),
      task("sink", { prompt: "all: {{result:fix}}", after: ["fix"] }),
    ]);
    const r = await runPlan(p, CFG, io);
    equal(spawn.calls.length, 2); // src + sink; no clones
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.fix, "skipped");
    equal(states.sink, "ok");
    ok(!("fix[0]" in states), "no clone rows for a skipped forEach");
    equal(promptOf(spawn.calls[1]), "all: "); // skipped parent inlines empty
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight: compute steps never trigger the provider health check", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '{"n":1}' }));
    const io = makeIo(spawn, { fetch: async () => { throw new Error("should not be called"); } });
    const p = plan(dir, [task("src"), computeTask("c", "deps['src'].n == 1", ["src"])]);
    const r = await runPlan(p, CFG, io); // must not reject on the health check
    equal(r.summary.tasks.find((t) => t.id === "c").state, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quota fail-fast never dooms pending compute steps", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const pr = promptOf(call);
      if (pr === "do o") return { exit: 1, output: "usage limit reached — resets at 3pm" };
      return { output: '{"n":1}', delayMs: 120 };
    });
    const io = makeIo(spawn);
    const cfgAllowed = { ...CFG, provider: { ...CFG.provider, allowedRoots: [tmpdir()] } };
    // open-model quota storm (family=false): a pending compute step must not be
    // swept up just because its sentinel model is also non-Claude
    const p = plan(dir, [
      task("o", { model: "glm-4.6:cloud" }),
      task("slow", { model: "haiku" }),
      computeTask("c", "deps['slow'].n == 1", ["slow"]),
    ]);
    const r = await runPlan(p, cfgAllowed, io);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.o, "quota");
    equal(states.slow, "ok");
    equal(states.c, "ok");
    equal(readResult(p.resultsDir, "c").outputJson, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("substituteItems unit: whole item, nested paths, index, missing fields", () => {
  equal(substituteItems("fix {{item.f}} #{{index}}", { f: "a" }, 0), "fix a #0");
  equal(substituteItems("{{item}}", { a: 1 }, 2), '{"a":1}');
  equal(substituteItems("{{item}}", "plain", 0), "plain");
  equal(substituteItems("{{item.a.b}}", { a: { b: "x" } }, 0), "x");
  equal(substituteItems("{{item.missing}}", {}, 0), "");
  equal(substituteItems("{{item.n}}", { n: 5 }, 0), "5");
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

// ── returns (schema-validated output) ─────────────────────────────────────────

const SITES_SCHEMA = { type: "object", required: ["sites"], properties: { sites: { type: "array" } } };
const streamOut = (text, sid, usage = { input_tokens: 100, output_tokens: 10 }, costUsd, apiKeySource) => [
  ...(sid ? [JSON.stringify({ type: "system", subtype: "init", session_id: sid, ...(apiKeySource && { apiKeySource }) })] : []),
  JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: text, usage,
    ...(costUsd != null && { total_cost_usd: costUsd }),
  }),
].join("\n") + "\n";

test("returns: conforming first output passes untouched — no second spawn", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: streamOut(JSON.stringify({ sites: [1] }), "s-1") }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", { returns: SITES_SCHEMA })]);
    await runPlan(p, CFG, io);
    equal(spawn.calls.length, 1);
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true);
    deepEqual(res.outputJson, { sites: [1] });
    equal(res.schemaRetried, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns: invalid output gets one teaching re-ask via session resume, then ok", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call, i) => i === 0
      ? { output: streamOut(JSON.stringify(["a.mjs"]), "s-1") } // valid JSON, wrong shape
      : { output: streamOut(JSON.stringify({ sites: ["a.mjs"] }), "s-2", { input_tokens: 50, output_tokens: 5 }) });
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", { returns: SITES_SCHEMA })]);
    await runPlan(p, CFG, io);

    equal(spawn.calls.length, 2);
    const retry = spawn.calls[1];
    const ri = retry.args.indexOf("--resume");
    equal(retry.args[ri + 1], "s-1");
    const rp = promptOf(retry);
    ok(rp.includes("expected object"), rp);        // the validator's teaching error
    ok(rp.includes(JSON.stringify(SITES_SCHEMA, null, 2)), rp); // the schema itself — the original prompt may have underspecified the shape
    ok(/only.*json/i.test(rp), rp);                // corrective instruction

    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true);
    deepEqual(res.outputJson, { sites: ["a.mjs"] });
    equal(res.schemaRetried, true);
    equal(res.sessionId, "s-2");                   // next ask continues the corrected thread
    deepEqual(res.tokens, { input: 150, output: 15, cacheCreation: 0, cacheRead: 0 });

    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ok(logLines.some((l) => l.event === "schema-retry" && l.id === "a"), "expected schema-retry in run.log");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns: still-invalid after the re-ask fails with the validator's message", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: streamOut("still prose", "s-1") }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", { returns: SITES_SCHEMA })]);
    await runPlan(p, CFG, io);
    equal(spawn.calls.length, 2);
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, false);
    ok(Array.isArray(res.schemaErrors) && res.schemaErrors.length > 0, JSON.stringify(res));
    ok(res.output.includes("returns validation failed"), res.output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns: no session id means no re-ask — fail immediately, one spawn", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "plain text, no stream-json" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", { returns: SITES_SCHEMA })]);
    await runPlan(p, CFG, io);
    equal(spawn.calls.length, 1);
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, false);
    ok(res.output.includes("no session id"), res.output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns on a forEach task: clones validate individually; the aggregate is engine-built and exempt", async () => {
  const dir = tmp();
  try {
    const CLONE_SCHEMA = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
    const spawn = fakeSpawnFactory((call) => {
      const prompt = promptOf(call);
      if (prompt.startsWith("do list")) return { output: streamOut(JSON.stringify({ sites: ["a", "b"] }), "s-list") };
      if (call.args.includes("--resume")) return { output: streamOut(JSON.stringify({ ok: false }), "s-fix") };
      if (prompt === "check a") return { output: streamOut("prose from clone 0", "s-c0") };
      return { output: streamOut(JSON.stringify({ ok: true }), "s-c1") };
    });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("list"),
      task("per", {
        prompt: "check {{item}}",
        after: ["list"],
        forEach: { from: "list", path: "sites", maxItems: 5 },
        returns: CLONE_SCHEMA,
      }),
    ]);
    await runPlan(p, CFG, io);

    equal(readResult(p.resultsDir, "per[0]").schemaRetried, true);  // corrected via resume
    equal(readResult(p.resultsDir, "per[0]").ok, true);
    equal(readResult(p.resultsDir, "per[1]").schemaRetried, undefined);
    const agg = readResult(p.resultsDir, "per");
    equal(agg.ok, true);                                            // array aggregate never re-validated
    deepEqual(agg.outputJson, [{ ok: false }, { ok: true }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── cost consent (estimates + single-shot projection warn) ────────────────────

test("summary task rows carry model, and costUsd only for real-key leaves; summary.estimate persists", async () => {
  const dir = tmp();
  try {
    // 'a' billed via API key -> costUsd is real; 'b' subscription -> synthetic, kept out of the corpus
    const spawn = fakeSpawnFactory((call) => promptOf(call) === "do a"
      ? { output: streamOut("done", "s-1", { input_tokens: 100, output_tokens: 10 }, 0.25, "ANTHROPIC_API_KEY") }
      : { output: streamOut("done", "s-2", { input_tokens: 100, output_tokens: 10 }, 0.25, "none") });
    const io = makeIo(spawn);
    const est = { tokens: 1234, counted: [{ model: "haiku", leaves: 1, perLeaf: 1234 }], unknown: [] };
    const p = plan(dir, [task("a"), task("b")], { estimate: est });
    const r = await runPlan(p, CFG, io);
    const rowA = r.summary.tasks.find((t) => t.id === "a");
    equal(rowA.model, "haiku");
    equal(rowA.costUsd, 0.25);
    const rowB = r.summary.tasks.find((t) => t.id === "b");
    equal(rowB.costUsd, undefined);
    deepEqual(r.summary.estimate, est);
    ok(io.lines.some((l) => l.includes("estimated ~1.2k tokens")), io.lines.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost warn: fires exactly once when the projection crosses costWarnTokens — stdout, run.log, notify", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call, i) => ({
      output: streamOut(`leaf ${i}`, `s-${i}`, { input_tokens: 3000, output_tokens: 0 }),
      delayMs: [5, 20, 300][i] ?? 1,
    }));
    const notified = [];
    const io = makeIo(spawn, { notify: (msg) => notified.push(msg) });
    const p = plan(dir, [task("a"), task("b"), task("c")]);
    const r = await runPlan(p, { ...CFG, costWarnTokens: 5000 }, io);

    const warns = io.lines.filter((l) => l.includes("projected"));
    equal(warns.length, 1);
    ok(warns[0].includes("⚠"), warns[0]);
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const events = logLines.filter((l) => l.event === "cost-warn");
    equal(events.length, 1);
    equal(events[0].unit, "tokens");
    equal(events[0].threshold, 5000);
    equal(events[0].projected, 9000); // 6000 spent after 2 leaves + 3000 avg × 1 remaining
    equal(notified.length, 1);
    equal(r.summary.costWarnFired, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost warn: silent under threshold, and disabled entirely by costWarn:false", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: streamOut("x", "s", { input_tokens: 10, output_tokens: 0 }) }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a"), task("b")]);
    const r = await runPlan(p, { ...CFG, costWarnTokens: 5000 }, io);
    equal(io.lines.filter((l) => l.includes("projected")).length, 0);
    equal(r.summary.costWarnFired, undefined);

    const spawn2 = fakeSpawnFactory(() => ({ output: streamOut("x", "s", { input_tokens: 3000, output_tokens: 0 }) }));
    const io2 = makeIo(spawn2);
    const p2 = plan(tmp(), [task("a"), task("b")]);
    await runPlan(p2, { ...CFG, costWarn: false, costWarnTokens: 5000 }, io2);
    equal(io2.lines.filter((l) => l.includes("projected")).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost warn: projects in dollars only when every completed leaf's costUsd is real-key billed", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call, i) => ({
      output: streamOut(`leaf ${i}`, `s-${i}`, { input_tokens: 10, output_tokens: 0 }, 6, "ANTHROPIC_API_KEY"),
      delayMs: [5, 20][i] ?? 1,
    }));
    const io = makeIo(spawn, { notify: () => {} });
    const p = plan(dir, [task("a"), task("b")]);
    await runPlan(p, { ...CFG, costWarnUsd: 10 }, io);
    const warns = io.lines.filter((l) => l.includes("projected"));
    equal(warns.length, 1);
    ok(warns[0].includes("$"), warns[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost warn: subscription costUsd is synthetic — projection stays token-denominated", async () => {
  const dir = tmp();
  try {
    // subscription leaves report costUsd but apiKeySource "none": the $10
    // default must NOT swallow the warn; tokens cross their threshold instead
    const spawn = fakeSpawnFactory((call, i) => ({
      output: streamOut(`leaf ${i}`, `s-${i}`, { input_tokens: 3000, output_tokens: 0 }, 0.05, "none"),
      delayMs: [5, 20][i] ?? 1,
    }));
    const io = makeIo(spawn, { notify: () => {} });
    const p = plan(dir, [task("a"), task("b")]);
    await runPlan(p, { ...CFG, costWarnTokens: 5000 }, io);
    const warns = io.lines.filter((l) => l.includes("projected"));
    equal(warns.length, 1);
    ok(warns[0].includes("tokens"), warns[0]);
    ok(!warns[0].includes("$"), warns[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── child manifests (bounded composition) ─────────────────────────────────────

const childPlanOf = (...tasks) => ({ tasks });

test("manifest node: children run namespaced, sinks aggregate as the node's output, dependents inline it", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const prompt = promptOf(call);
      if (prompt === "scan things") return { output: streamOut(JSON.stringify({ found: 2 }), "s-scan") };
      if (prompt.startsWith("sum")) return { output: streamOut("two things", "s-sum") };
      return { output: streamOut(`final saw: ${prompt.split("|")[1]}`, "s-final") };
    });
    const io = makeIo(spawn);
    const node = task("audit", {
      model: "manifest", prompt: "",
      childPlan: childPlanOf(
        task("scan", { prompt: "scan things" }),
        task("sum", { prompt: "sum {{result:scan}}", after: ["scan"] }),
      ),
    });
    const p = plan(dir, [node, task("final", { prompt: "final|{{result:audit}}", after: ["audit"] })]);
    await runPlan(p, CFG, io);

    equal(readResult(p.resultsDir, "audit~scan").ok, true);
    equal(readResult(p.resultsDir, "audit~sum").ok, true);
    // within-child {{result:}} resolved to the namespaced id
    const sumCall = spawn.calls.find((c) => promptOf(c).startsWith("sum"));
    ok(promptOf(sumCall).includes(JSON.stringify({ found: 2 })), promptOf(sumCall));
    // the node aggregates its sinks: only 'sum' has no within-child dependents
    const agg = readResult(p.resultsDir, "audit");
    equal(agg.ok, true);
    deepEqual(agg.outputJson, { sum: "two things" });
    // and the dependent's template inlined it
    const finalRes = readResult(p.resultsDir, "final");
    ok(finalRes.output.includes('"sum":"two things"'), finalRes.output);

    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const expand = logLines.find((l) => l.event === "expand-manifest");
    deepEqual(expand.children, [{ id: "audit~scan", model: "haiku" }, { id: "audit~sum", model: "haiku" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach × child: per-item child copies with {{item}} substituted; one item's failure dooms only the node", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const prompt = promptOf(call);
      if (prompt === "do seed") return { output: streamOut(JSON.stringify(["alpha", "beta"]), "s-seed") };
      if (prompt === "ask alpha") return { output: streamOut("", "s-a0"), exit: 1 }; // alpha's scan fails
      if (prompt === "ask beta") return { output: streamOut("beta says hi", "s-b0") };
      return { output: streamOut(`condensed: ${prompt}`, "s-x") };
    });
    const io = makeIo(spawn);
    const node = task("audit", {
      model: "manifest", prompt: "", after: ["seed"],
      forEach: { from: "seed", path: "", maxItems: 5 },
      childPlan: childPlanOf(
        task("ask", { prompt: "ask {{item}}" }),
        task("cut", { prompt: "cut {{result:ask}}", after: ["ask"] }),
      ),
    });
    const p = plan(dir, [task("seed"), node]);
    await runPlan(p, CFG, io);

    // beta's chain completed
    equal(readResult(p.resultsDir, "audit[1]~ask").ok, true);
    equal(readResult(p.resultsDir, "audit[1]~cut").ok, true);
    // alpha's scan failed -> alpha's cut blocked -> the audit aggregate is doomed
    equal(readResult(p.resultsDir, "audit[0]~ask").ok, false);
    equal(readResult(p.resultsDir, "audit[0]~cut"), null);
    const summary = JSON.parse(readFileSync(join(p.resultsDir, "summary.json"), "utf8"));
    equal(summary.tasks.find((t) => t.id === "audit[0]~cut").state, "blocked");
    equal(summary.tasks.find((t) => t.id === "audit").state, "blocked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("child compute reads deps by local id through aliases", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => promptOf(call) === "list"
      ? { output: streamOut(JSON.stringify({ xs: [3, 1, 3] }), "s-l") }
      : { output: streamOut("done", "s-d") });
    const io = makeIo(spawn);
    const node = task("crunch", {
      model: "manifest", prompt: "",
      childPlan: childPlanOf(
        task("get", { prompt: "list" }),
        { id: "dedupe", model: "compute", prompt: "", allowedTools: "", cwd: tmpdir(), originalCwd: tmpdir(), scratchRedirect: false, timeoutMs: 5000, after: ["get"], compute: "unique_by(filter(deps['get'].xs, item > 0), '')" },
      ),
    });
    // unique_by needs objects; keep it simple: sum instead
    node.childPlan.tasks[1].compute = "sum(deps['get'].xs)";
    const p = plan(dir, [node]);
    await runPlan(p, CFG, io);
    const agg = readResult(p.resultsDir, "crunch");
    equal(agg.ok, true);
    deepEqual(agg.outputJson, { dedupe: 7 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: prior-ok child tasks skip on re-run", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => ({ output: streamOut(`out: ${promptOf(call)}`, "s") }));
    const io = makeIo(spawn);
    const node = () => task("audit", {
      model: "manifest", prompt: "",
      childPlan: childPlanOf(task("scan", { prompt: "scan" }), task("sum", { prompt: "sum it", after: ["scan"] })),
    });
    const p = plan(dir, [node()]);
    await runPlan(p, CFG, io);
    equal(spawn.calls.length, 2);

    const spawn2 = fakeSpawnFactory(() => ({ output: streamOut("should not run", "s2") }));
    const io2 = makeIo(spawn2);
    const p2 = { ...plan(dir, [node()]), resultsDir: p.resultsDir };
    await runPlan(p2, CFG, io2);
    equal(spawn2.calls.length, 0); // both children skipped, node re-aggregated
    equal(readResult(p.resultsDir, "audit").ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
