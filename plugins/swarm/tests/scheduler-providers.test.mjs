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
test("Codex canonical completion persists provider, runner, session, and usage", async () => {
  const dir = tmp();
  try {
    const cwd = tmpdir();
    const stream = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-stage4" }),
      JSON.stringify({ type: "response.output_text.delta", delta: "codex answer" }),
      JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 7 } } }),
    ].join("\n") + "\n";
    const cfg = {
      providers: {
        claude: { enabled: true },
        ollama: { enabled: true, allowedRoots: [] },
        codex: { enabled: true, path: "codex", allowedRoots: [cwd] },
      },
      timeoutMs: 600000,
    };
    const p = plan(dir, [task("codex", {
      model: "gpt-5-codex", provider: "codex", cwd, originalCwd: cwd, allowedTools: "Read",
    })], { concurrency: 1 });
    const spawn = fakeSpawnFactory(() => ({ output: stream }));
    const r = await runPlan(p, cfg, makeIo(spawn, { env: usageEnv({ codex: codexReading() }) }));
    const result = readResult(p.resultsDir, "codex");
    equal(r.summary.tasks[0].state, "ok");
    equal(result.provider, "codex");
    equal(result.runner, "codex");
    equal(result.sessionId, "thread-stage4");
    equal(result.output, "codex answer");
    deepEqual(result.tokens, { input: 11, output: 7, cacheCreation: 0, cacheRead: 0 });
    const log = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    ok(log.some((entry) => entry.event === "session" && entry.provider === "codex" && entry.runner === "codex"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Claude-shaped stream cannot complete a Codex runner", async () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "wrong-protocol" }),
    JSON.stringify({ type: "result", subtype: "success", result: "not a Codex terminal" }),
  ].join("\n") + "\n";
  const cwd = tmpdir();
  const cfg = {
    providers: {
      claude: { enabled: true },
      ollama: { enabled: true, allowedRoots: [] },
      codex: { enabled: true, path: "codex", allowedRoots: [cwd] },
    },
  };
  const r = await runTask(task("codex-protocol", {
    model: "gpt-5-codex", provider: "codex", cwd, originalCwd: cwd,
  }), "answer", cfg, makeIo(fakeSpawnFactory(() => ({ output: stream }))));
  equal(r.ok, false);
  match(r.output, /terminal/i);
});

test("a Claude terminal is_error is reported as a runner error, not a dead session", async () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s-err" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "API Error: overloaded" }),
  ].join("\n") + "\n";
  const r = await runTask(task("claude-err", { provider: "claude" }), "go", CFG, makeIo(fakeSpawnFactory(() => ({ output: stream }))));
  equal(r.ok, false);
  match(r.output, /^leaf ended with a runner error: API Error: overloaded/);
});

test("a Claude quota failure does not fail-fast an unrelated provider", async () => {
  const dir = tmp();
  try {
    const cwd = tmpdir();
    const cfg = {
      providers: {
        claude: { enabled: true, allowedRoots: [cwd] },
        ollama: { enabled: true, mode: "env", url: "http://127.0.0.1:1", authToken: "ollama", allowedRoots: [cwd] },
        codex: { enabled: false, allowedRoots: [cwd] },
      },
      timeoutMs: 600000,
    };
    const spawn = fakeSpawnFactory((call) => {
      const model = call.args[call.args.indexOf("--model") + 1];
      return model === "claude-sonnet-5" || model === "claude-haiku-4-5-20251001"
        ? { exit: 1, output: "usage limit reached" }
        : { output: "open provider completed" };
    });
    const p = plan(dir, [
      task("claude-first", { model: "claude-sonnet-5", provider: "claude", cwd, originalCwd: cwd }),
      task("claude-second", { model: "claude-haiku-4-5-20251001", provider: "claude", cwd, originalCwd: cwd }),
      task("ollama-leaf", { model: "glm-5.2:cloud", provider: "ollama", cwd, originalCwd: cwd }),
    ], { concurrency: 1 });
    const r = await runPlan(p, cfg, makeIo(spawn));
    const states = Object.fromEntries(r.summary.tasks.map((row) => [row.id, row.state]));
    equal(states["claude-first"], "quota");
    equal(states["claude-second"], "quota");
    equal(states["ollama-leaf"], "ok");
    equal(spawn.calls.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const MIXED_CFG = (cwd) => ({
  providers: {
    claude: { enabled: true, allowedRoots: [cwd] },
    ollama: { enabled: true, mode: "env", url: "http://127.0.0.1:1", authToken: "ollama", allowedRoots: [cwd] },
    codex: { enabled: true, path: "codex", allowedRoots: [cwd] },
  },
  timeoutMs: 600000,
});
const CODEX_STREAM = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-mixed" }),
  JSON.stringify({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "thinking it over" } }),
  JSON.stringify({ type: "item.completed", item: { id: "m0", type: "agent_message", text: "Reading the file first." } }),
  JSON.stringify({ type: "item.completed", item: { id: "c1", type: "command_execution", aggregated_output: "ls output" } }),
  JSON.stringify({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "codex answer" } }),
  JSON.stringify({ type: "item.completed", item: { id: "r2", type: "reasoning", text: "trailing reasoning" } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } }),
].join("\n") + "\n";
const isCodexCall = (call) => call.args.includes("exec");

test("a mixed Claude/Ollama/Codex DAG runs on two runners and persists each identity", async () => {
  const dir = tmp();
  try {
    const cwd = tmpdir();
    const spawn = fakeSpawnFactory((call) => (isCodexCall(call) ? { output: CODEX_STREAM } : { output: "claude-runner answer" }));
    const p = plan(dir, [
      task("c", { model: "claude-sonnet-5", provider: "claude", cwd, originalCwd: cwd }),
      task("o", { model: "glm-5.2:cloud", provider: "ollama", cwd, originalCwd: cwd }),
      task("x", { model: "gpt-5-codex", provider: "codex", cwd, originalCwd: cwd, after: ["c", "o"] }),
    ]);
    const r = await runPlan(p, MIXED_CFG(cwd), makeIo(spawn, { env: usageEnv({ codex: codexReading() }) }));
    deepEqual(r.summary.tasks.map((t) => t.state), ["ok", "ok", "ok"]);
    const identity = (id) => { const res = readResult(p.resultsDir, id); return [res.provider, res.runner]; };
    deepEqual(identity("c"), ["claude", "claude"]);
    deepEqual(identity("o"), ["ollama", "claude"]);
    deepEqual(identity("x"), ["codex", "codex"]);
    equal(spawn.calls.filter(isCodexCall).length, 1);
    equal(readResult(p.resultsDir, "x").output, "codex answer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a schema correction turn resumes the same Codex thread and logs its identity", async () => {
  const dir = tmp();
  try {
    const cwd = tmpdir();
    const codexOut = (text) => [
      JSON.stringify({ type: "thread.started", thread_id: "thread-fix" }),
      JSON.stringify({ type: "item.completed", item: { id: "m1", type: "agent_message", text } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join("\n") + "\n";
    const spawn = fakeSpawnFactory((call, i) => ({ output: codexOut(i === 0 ? "not json" : '{"ok":true}') }));
    const p = plan(dir, [task("fix", {
      model: "gpt-5-codex", provider: "codex", cwd, originalCwd: cwd,
      returns: { type: "object", required: ["ok"] }, verifyCitations: false,
    })]);
    const r = await runPlan(p, MIXED_CFG(cwd), makeIo(spawn, { env: usageEnv({ codex: codexReading() }) }));
    equal(r.summary.tasks[0].state, "ok");
    equal(spawn.calls.length, 2);
    ok(spawn.calls[1].args.includes("resume") && spawn.calls[1].args.includes("thread-fix"));
    const log = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ok(log.some((e) => e.event === "leaf-contract-retry" && e.provider === "codex" && e.runner === "codex"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a quota fallback re-resolves provider and runner for the target model", async () => {
  const dir = tmp();
  try {
    const cwd = tmpdir();
    const spawn = fakeSpawnFactory((call) => (isCodexCall(call) ? { output: CODEX_STREAM } : { exit: 1, output: "usage limit reached" }));
    const p = plan(dir, [task("fb", {
      model: "claude-sonnet-5", provider: "claude", fallbackModel: "gpt-5-codex", fallbackProvider: "codex", cwd, originalCwd: cwd,
    })]);
    const r = await runPlan(p, MIXED_CFG(cwd), makeIo(spawn));
    equal(r.summary.tasks[0].state, "ok");
    const res = readResult(p.resultsDir, "fb");
    equal(res.provider, "codex");
    equal(res.runner, "codex");
    equal(res.model, "gpt-5-codex");
    const log = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ok(log.some((e) => e.event === "fallback" && e.fromProvider === "claude" && e.toProvider === "codex"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rejected fallback ends only its own leaf; the run and its siblings continue", async () => {
  const dir = tmp();
  try {
    const cwd = tmpdir();
    const cfg = MIXED_CFG(cwd);
    cfg.providers.codex.enabled = false;
    const spawn = fakeSpawnFactory((call) => {
      const model = call.args[call.args.indexOf("--model") + 1];
      return model === "claude-sonnet-5" ? { exit: 1, output: "usage limit reached" } : { output: "open provider completed" };
    });
    const p = plan(dir, [
      task("fb", { model: "claude-sonnet-5", provider: "claude", fallbackModel: "gpt-5-codex", fallbackProvider: "codex", cwd, originalCwd: cwd }),
      task("sib", { model: "glm-5.2:cloud", provider: "ollama", cwd, originalCwd: cwd }),
    ], { concurrency: 1 });
    const r = await runPlan(p, cfg, makeIo(spawn));
    const states = Object.fromEntries(r.summary.tasks.map((row) => [row.id, row.state]));
    equal(states.fb, "quota");
    equal(states.sib, "ok");
    const log = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ok(log.some((e) => e.event === "fallback-rejected" && e.id === "fb" && /disabled/i.test(e.reason)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
