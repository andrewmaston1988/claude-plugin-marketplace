import { test } from "node:test";
import { equal, deepEqual, ok, rejects, match } from "node:assert/strict";
import { rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { runPlan, runTask, substituteTemplates, substituteItems, classifyFailure, pickNewestRunning } from "../src/scheduler.mjs";
import { writeResult, readResult, initResultsDir, resultPath } from "../src/results.mjs";
import { CFG, tmp, task, plan, computeTask, childPlanOf, fakeSpawnFactory, makeIo, promptOf, sentPrompt, usageEnv, codexReading, SHIM, streamOut, gitInRepo, initGitRepo, commitAllInRepo, fakeWorktree, buildStrandPlan, integrateLeaf, forEachFixLeaf, fixCloneTasks } from "./helpers/scheduler-fixtures.mjs";
// errorCode/ENAMETOOLONG: a spawn error whose e.code is a deterministic argv-size
// failure must never burn a retry attempt on a leaf that will fail identically.
test("runTask: a synchronous spawn throw carries e.code through as result.errorCode", async () => {
  const dir = tmp();
  try {
    const io = makeIo(() => { const e = new Error("spawn ENAMETOOLONG"); e.code = "ENAMETOOLONG"; throw e; });
    const r = await runTask(task("a"), "do a", CFG, io, null, {});
    equal(r.ok, false);
    equal(r.exit, null);
    equal(r.errorCode, "ENAMETOOLONG");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runTask: an async child 'error' event carries e.code through as result.errorCode", async () => {
  const dir = tmp();
  try {
    const io = makeIo((cmd, args, opts) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => {
        const e = new Error("spawn ENOENT");
        e.code = "ENOENT";
        child.emit("error", e);
      }, 1);
      return child;
    });
    const r = await runTask(task("a"), "do a", CFG, io, null, {});
    equal(r.ok, false);
    equal(r.exit, null);
    equal(r.errorCode, "ENOENT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPlan: a spawn error with errorCode ENAMETOOLONG never retries, even with a spawn-error retry budget", async () => {
  const dir = tmp();
  try {
    let calls = 0;
    const io = makeIo((cmd, args, opts) => {
      calls++;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => {
        const e = new Error("spawn ENAMETOOLONG");
        e.code = "ENAMETOOLONG";
        child.emit("error", e);
      }, 1);
      return child;
    });
    const p = plan(dir, [task("a")]);
    const r = await runPlan(p, { ...CFG, retry: { spawnError: 1 } }, io);
    equal(calls, 1, "ENAMETOOLONG must not be retried, unlike a generic spawn error");
    equal(r.summary.tasks[0].state, "failed");
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
      properties: { findings: { type: "array" } },
      required: ["findings"],
    };
    // findings must be an array; the model returned a string whose text IS the
    // 429 — transcript grep would misread this schema failure as transient and
    // burn full re-runs on it. No session id, so the one re-ask is unavailable.
    const spawn = fakeSpawnFactory(() => ({ output: '{"findings":"429 — expected an array, got a string"}' }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", { cwd: dir, returns })]);
    const r = await runPlan(p, { ...CFG, retry: { rateLimited: 2, backoffMs: 10 } }, io);
    equal(spawn.calls.length, 1, `semantic failure must not re-run as transient (got ${spawn.calls.length} dispatches)`);
    equal(r.summary.tasks[0].state, "failed");
    ok(readResult(p.resultsDir, "a").schemaErrors?.length, "schemaErrors recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A claude -p session that dies mid-thinking still exits 0 with an empty result — the
// false-green that read as "ok". The signal: assistant events with no terminal result
// event of any kind, so `includeResult: false` is what represents mid-stream death.
const streamStop = (stopReason, { result = "", includeResult = true } = {}) => [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
  JSON.stringify({ type: "assistant", message: { id: "m1", stop_reason: stopReason } }),
  ...(includeResult ? [JSON.stringify({ type: "result", subtype: "success", is_error: false, result })] : []),
].join("\n") + "\n";

test("false-green: an exit-0 leaf that never emitted a result event (cut mid-stream) is marked failed", async () => {
  const dir = tmp();
  try {
    // exit 0, died mid-thinking: no terminal result event at all
    const spawn = fakeSpawnFactory(() => ({ output: streamStop(null, { includeResult: false }) }));
    const io = makeIo(spawn);
    const r = await runPlan(plan(dir, [task("a", { cwd: dir })]), CFG, io);
    equal(r.summary.tasks.find((t) => t.id === "a").state, "failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("clean finish: an exit-0 leaf that emitted stop_reason end_turn stays ok", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: streamStop("end_turn", { result: "done" }) }));
    const io = makeIo(spawn);
    const r = await runPlan(plan(dir, [task("a", { cwd: dir })]), CFG, io);
    equal(r.summary.tasks.find((t) => t.id === "a").state, "ok");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// :cloud proxies (glm/kimi) never put stop_reason on assistant stream events —
// only the terminal result event carries it — so judging by assistant events
// alone misclassified every successful :cloud leaf as "terminated mid-stream".
test("clean finish: a :cloud-style leaf with no assistant end_turn but a success result event stays ok", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: streamStop(null, { result: "done" }) }));
    const io = makeIo(spawn);
    const r = await runPlan(plan(dir, [task("a", { cwd: dir })]), CFG, io);
    equal(r.summary.tasks.find((t) => t.id === "a").state, "ok");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fallback: quota leaf re-dispatches immediately on its declared fallbackModel", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      call.args[call.args.indexOf("--model") + 1] === "claude-sonnet-5"
        ? { exit: 1, output: "Claude AI usage limit reached|1751210400" }
        : { output: "fallback did it" });
    const io = makeIo(spawn);
    const p = plan(dir, [task("judge", { provider: "claude", model: "claude-sonnet-5", fallbackProvider: "claude", fallbackModel: "claude-haiku-4-5-20251001" })]);
    const r = await runPlan(p, { ...CFG, retry: { backoffMs: 10 } }, io);
    equal(spawn.calls.length, 2);
    equal(spawn.calls[1].args[spawn.calls[1].args.indexOf("--model") + 1], "claude-haiku-4-5-20251001");
    equal(r.summary.tasks[0].state, "ok");
    equal(readResult(p.resultsDir, "judge").output, "fallback did it");
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const fb = logLines.find((l) => l.event === "fallback");
    deepEqual({ from: fb.from, to: fb.to }, { from: "claude-sonnet-5", to: "claude-haiku-4-5-20251001" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The machinery fact, not the model's fault: `grade --init` reads this field to
// pre-fill the infra outcome, so a missing one files a quota death as `failed`.
test("quota: a quota-killed leaf's result records failureClass quota", async () => {
  const dir = tmp();
  try {
    const io = makeIo(fakeSpawnFactory(() => ({ exit: 1, output: "usage limit reached — resets at 3pm" })));
    const p = plan(dir, [task("a", { provider: "claude", model: "claude-sonnet-5" })]);
    await runPlan(p, CFG, io);
    const res = readResult(p.resultsDir, "a");
    equal(res.failureClass, "quota");
    equal(res.quotaResetsAt, "3pm", "the reset time still rides the same record");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rate-limited: a leaf past its retry budget records failureClass rate-limited", async () => {
  const dir = tmp();
  try {
    const io = makeIo(fakeSpawnFactory(() => ({ exit: 1, output: "429 Too Many Requests" })));
    const p = plan(dir, [task("a", { provider: "claude", model: "claude-sonnet-5" })]);
    await runPlan(p, { ...CFG, retry: { rateLimited: 1, backoffMs: 10 } }, io);
    equal(readResult(p.resultsDir, "a").failureClass, "rate-limited");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A leaf that recovered on its fallback is not an infra failure — the success
// rewrites the whole result, so the failed attempt's class must not survive.
test("fallback: a leaf that recovered on its fallback records no failureClass", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      call.args[call.args.indexOf("--model") + 1] === "claude-sonnet-5"
        ? { exit: 1, output: "Claude AI usage limit reached|1751210400" }
        : { output: "fallback did it" });
    const io = makeIo(spawn);
    const p = plan(dir, [task("judge", { provider: "claude", model: "claude-sonnet-5", fallbackProvider: "claude", fallbackModel: "claude-haiku-4-5-20251001" })]);
    const r = await runPlan(p, { ...CFG, retry: { backoffMs: 10 } }, io);
    equal(r.summary.tasks[0].state, "ok");
    equal(readResult(p.resultsDir, "judge").failureClass, undefined, "a recovered leaf carries no infra class");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("quota fail-fast: first Claude quota pre-emptively marks pending Claude leaves without fallback", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ exit: 1, output: "usage limit reached — resets at 3pm" }));
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("first", { provider: "claude", model: "claude-sonnet-5" }),
      task("second", { provider: "claude", model: "claude-haiku-4-5-20251001" }),
      task("saved", { provider: "claude", model: "claude-opus-5", fallbackProvider: "claude", fallbackModel: "claude-haiku-4-5-20251001" }),
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
    const p1 = plan(dir, [task("s", { provider: "claude", model: "claude-sonnet-5" }), task("o", { provider: "claude", model: "claude-opus-5" }), task("h", { provider: "claude", model: "claude-haiku-4-5-20251001" })]);
    await runPlan(p1, CFG, io1);
    equal(io1.spawn.calls.length, 3, "non-scoped Claude models must still dispatch");

    // A Fable leaf IS constrained by the exhausted Fable bucket → still aborts.
    const home2 = join(dir, "home2");
    mkdirSync(home2, { recursive: true });
    const io2 = mkIo(home2);
    const p2 = plan(dir, [task("f", { provider: "claude", model: "claude-fable-5" })]);
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
    await rejects(() => runPlan(plan(dir, [task("s", { provider: "claude", model: "claude-sonnet-5" })]), CFG, io), /Sonnet.*scoped limit/i);
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
    const p = plan(dir, [task("c", { provider: "claude", model: "claude-sonnet-5" })]);
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
    const p2 = plan(dir, [task("c2", { provider: "claude", model: "claude-sonnet-5" })], { resultsDir: join(dir, "run2") });
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

// The p5-review failure, reproduced: find-specpin returned 7 findings, the cap cut
// the inlined copy, and verify-specpin checked only the first 5 — while the digest
// reported all 7 as verified. The cut must surface on the leaf, the summary, and run.log.
test("integration: a {{result:}} cut to the cap is loud on the leaf, the summary, and run.log", async () => {
  const dir = tmp();
  try {
    const long = "F".repeat(50); // finder output, far over the tiny cap below
    const spawn = fakeSpawnFactory((call) => {
      const pr = promptOf(call);
      if (pr === "do find") return { output: long };
      return { output: "verdicts" };
    });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("find"),
      task("verify", { prompt: "check: {{result:find}}", after: ["find"] }),
    ]);
    const r = await runPlan(p, { ...CFG, resultInlineCap: 10 }, io);

    // the verifier really did see only a prefix
    equal(promptOf(spawn.calls[1]), `check: ${"F".repeat(10)}`);

    // 1. stamped on the consuming leaf's own result — what a drill-down reads
    const verify = readResult(p.resultsDir, "verify");
    equal(verify.promptTruncations.length, 1);
    equal(verify.promptTruncations[0].depId, "find");
    equal(verify.promptTruncations[0].kept, 10);
    equal(verify.promptTruncations[0].total, 50);

    // 2. in the run summary, on the same channel forEach's maxItems cap uses
    const tr = r.summary.truncations;
    equal(tr.length, 1);
    equal(tr[0].kind, "prompt");
    equal(tr[0].id, "verify");
    equal(tr[0].depId, "find");

    // 3. in run.log
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const evt = logLines.find((l) => l.event === "truncate-prompt");
    ok(evt, "run.log must carry a truncate-prompt event");
    equal(evt.id, "verify");
    equal(evt.depId, "find");
    equal(evt.total, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Control: the same shape under the cap must stay silent, or the warning says nothing.
test("integration: a {{result:}} that fits under the cap records no truncation", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => (promptOf(call) === "do find" ? { output: "short" } : { output: "v" }));
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("find"),
      task("verify", { prompt: "check: {{result:find}}", after: ["find"] }),
    ]);
    const r = await runPlan(p, { ...CFG, resultInlineCap: 4000 }, io);
    equal(readResult(p.resultsDir, "verify").promptTruncations, undefined);
    equal(r.summary.truncations, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("substituteTemplates unit: path + cap", () => {
  const dir = tmp();
  try {
    initResultsDir(join(dir, "run"));
    writeResult(join(dir, "run"), "dep", { id: "dep", ok: true, output: "abcdef" });
    const { prompt } = substituteTemplates("x {{result:dep}} y {{resultPath:dep}}", join(dir, "run"), 3);
    equal(prompt, `x abc y ${resultPath(join(dir, "run"), "dep")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A {{result:}} that exceeds the cap silently fed verifiers a PREFIX of their
// finder's findings — unverified findings then read as verified. It must be loud.
test("substituteTemplates reports a truncation when a dep's output exceeds the cap", () => {
  const dir = tmp();
  try {
    initResultsDir(join(dir, "run"));
    writeResult(join(dir, "run"), "dep", { id: "dep", ok: true, output: "abcdef" });
    const { prompt, truncations } = substituteTemplates("x {{result:dep}}", join(dir, "run"), 3);
    equal(prompt, "x abc");
    equal(truncations.length, 1);
    equal(truncations[0].depId, "dep");
    equal(truncations[0].kept, 3);
    equal(truncations[0].total, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Control: a check that fires always says nothing.
test("substituteTemplates reports no truncation when the dep fits under the cap", () => {
  const dir = tmp();
  try {
    initResultsDir(join(dir, "run"));
    writeResult(join(dir, "run"), "dep", { id: "dep", ok: true, output: "abc" });
    const { prompt, truncations } = substituteTemplates("x {{result:dep}}", join(dir, "run"), 100);
    equal(prompt, "x abc");
    equal(truncations.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// {{resultPath:}} hands the leaf a path to Read — nothing is inlined, so nothing truncates.
test("substituteTemplates never truncates a {{resultPath:}} reference", () => {
  const dir = tmp();
  try {
    initResultsDir(join(dir, "run"));
    writeResult(join(dir, "run"), "dep", { id: "dep", ok: true, output: "abcdef" });
    const { truncations } = substituteTemplates("x {{resultPath:dep}}", join(dir, "run"), 3);
    equal(truncations.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The p5-review failure: find-deletions re-ran, but verify-deletions (which exists
// ONLY to check it) was skipped on its previous-pass `ok`, and __digest was skipped
// AND digest.md rewritten from the previous run's body. The run then reported success
// and handed the session a verdict that predated everything the resume produced.
// A cached result is only valid if every input that produced it is unchanged.
