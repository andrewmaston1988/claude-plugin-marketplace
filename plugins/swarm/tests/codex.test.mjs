import { test } from "node:test";
import { deepEqual, equal, match, ok, rejects, throws } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildCodexInvocation,
  classifyCodexExit,
  createCodexAppServerClient,
  createCodexProviderAdapter,
  createCodexRunnerAdapter,
  discoverCodexModels,
  normalizeCodexModel,
} from "../src/codex.mjs";
import { createCodexStreamParser, createRunnerParser } from "../src/stream.mjs";
import { assertProviderAdapterContract } from "./helpers/provider-contract.mjs";
import { assertRunnerAdapterContract } from "./helpers/runner-contract.mjs";

const SHIM = fileURLToPath(new URL("./shims/codex-shim.mjs", import.meta.url));

test("Codex app-server discovery initializes, follows cursors, and normalizes descriptors", async () => {
  const models = await discoverCodexModels({}, {
    executable: process.execPath,
    args: [SHIM, "app-server"],
    env: { SWARM_CODEX_SHIM_PAGE: "paged" },
  });
  deepEqual(models.map((model) => model.model), ["gpt-5-codex", "gpt-5-mini"]);
  deepEqual(models.map((model) => model.provider), ["codex", "codex"]);
  equal(models[0].runner, "codex");
});

test("Codex discovery deduplicates model rows from an injected client", async () => {
  const calls = [];
  const client = {
    async initialize() { calls.push("initialize"); },
    async request(method, params) {
      calls.push([method, params.cursor]);
      return { data: [{ id: "gpt-5-codex" }, { id: "gpt-5-codex" }], nextCursor: null };
    },
  };
  const models = await discoverCodexModels({}, { client });
  deepEqual(models, [{ provider: "codex", model: "gpt-5-codex", runner: "codex" }]);
  deepEqual(calls, ["initialize", ["model/list", null]]);
});

test("Codex model normalization preserves optional capabilities", () => {
  deepEqual(normalizeCodexModel({
    id: "gpt-5-codex",
    display_name: "GPT-5 Codex",
    supportedReasoningEfforts: ["low", { reasoningEffort: "high" }],
    inputModalities: ["text", "text"],
    isDefault: true,
  }), {
    provider: "codex",
    model: "gpt-5-codex",
    runner: "codex",
    displayName: "GPT-5 Codex",
    efforts: ["low", "high"],
    modalities: ["text"],
    isDefault: true,
  });
});

test("Codex runner invocation is sandboxed, resumable, and contract-valid", () => {
  const invocation = buildCodexInvocation({
    model: "gpt-5-codex",
    effort: "high",
    write: true,
    sessionId: "thread-123",
    additionalDirs: ["C:/repo"],
  }, "solve this", {});
  equal(invocation.argv[1], "exec");
  const resumeIndex = invocation.argv.indexOf("resume");
  ok(resumeIndex > 1);
  ok(invocation.argv.includes("--json"));
  ok(invocation.argv.includes("--sandbox") && invocation.argv.includes("workspace-write"));
  ok(invocation.argv.includes("thread-123"));
  ok(invocation.argv.includes("C:/repo"));
  const shim = spawnSync(process.execPath, [SHIM, ...invocation.argv.slice(1)], { encoding: "utf8" });
  equal(shim.status, 0, shim.stderr);
  throws(() => buildCodexInvocation({ model: "gpt-5-codex", sandbox: "danger-full-access" }, "x"), /read-only or workspace-write/);
  assertRunnerAdapterContract(createCodexRunnerAdapter(), { task: { provider: "codex", model: "gpt-5-codex" } });
});

test("Codex parser normalizes JSONL text, usage, and terminal failure", () => {
  const events = [];
  const parser = createCodexStreamParser({ emit: (event) => events.push(event) });
  parser.feed('{"type":"thread.started","thread_id":"thread-1"}\n');
  parser.feed('{"type":"response.output_text.delta","item_id":"m1","delta":"hel"}\n{"type":"response.output_text.delta","item_id":"m1","delta":"lo"}\n');
  parser.feed('{"type":"turn.completed","model":"gpt-5-codex","usage":{"input_tokens":20,"output_tokens":5,"cached_input_tokens":3}}\n');
  parser.end();
  deepEqual(parser.result(), {
    sessionId: "thread-1",
    realModel: "gpt-5-codex",
    output: "hello",
    usage: { input: 20, output: 5, cacheCreation: 0, cacheRead: 3 },
    terminal: true,
  });
  equal(events.filter((event) => event.terminal === true).length, 1);
  equal(events.filter((event) => event.type === "text").map((event) => event.text).join(""), "hello");

  const finalOnly = createCodexStreamParser();
  finalOnly.feed('{"type":"turn.completed","output_text":"final-only"}\n');
  finalOnly.end();
  equal(finalOnly.result().output, "final-only");

  const failed = [];
  const errors = [];
  const completions = [];
  const incomplete = createCodexStreamParser({
    emit: (event) => failed.push(event),
    onError: (event) => errors.push(event),
    onComplete: (event) => completions.push(event),
  });
  incomplete.feed('{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"partial"}}\n');
  incomplete.end();
  equal(failed.at(-1).type, "error");
  equal(errors.length, 1);
  equal(completions.length, 0);
  match(String(failed.at(-1).error.code), /missing_terminal/);
  const classified = classifyCodexExit({ code: 0 }, incomplete.result(), { model: "gpt-5-codex" });
  equal(classified.terminal, false);
  match(String(classified.error.code), /missing_terminal/);
});

test("Codex parser output is the final agent message, never reasoning or interim items", () => {
  const parser = createCodexStreamParser();
  parser.feed([
    '{"type":"thread.started","thread_id":"thread-2"}',
    '{"type":"item.completed","item":{"id":"r1","type":"reasoning","text":"**Planning the scan**"}}',
    '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"I will read the file first."}}',
    '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"cat a.txt","aggregated_output":"x","status":"completed"}}',
    '{"type":"item.completed","item":{"id":"e1","type":"error","message":"transient tool warning"}}',
    '{"type":"item.completed","item":{"id":"m2","type":"agent_message","text":"{\\"ok\\":true}"}}',
    '{"type":"item.completed","item":{"id":"r2","type":"reasoning","text":"**Wrapping up**"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    "",
  ].join("\n"));
  parser.end();
  equal(parser.result().output, '{"ok":true}');
});

test("Codex app-server rejects a request when stdin fails synchronously", async () => {
  const child = {
    stdin: { write() { throw new Error("broken pipe"); } },
    stdout: { on() {} },
    stderr: { on() {} },
    on() {},
    kill() {},
  };
  const client = createCodexAppServerClient({ spawnImpl: () => child });
  await rejects(() => client.request("model/list"), /broken pipe/);
  equal(client.diagnostics.pending, 0);
});

test("Codex runner parser registry exposes both provider factories", () => {
  ok(createRunnerParser("codex", { emit: () => {} }));
  ok(createRunnerParser("claude", { emit: () => {} }));
});

test("Codex provider adapter passes the concrete provider contract", async () => {
  const client = {
    async initialize() {},
    async request() { return { data: [{ id: "gpt-5-codex" }], nextCursor: null }; },
  };
  const adapter = createCodexProviderAdapter({ client });
  await assertProviderAdapterContract(adapter, {
    config: { providers: { codex: { enabled: true } } },
    context: { client },
  });
  equal(adapter.enabled({ providers: { codex: { enabled: false } } }), false);
});

test("Codex app-server client reports request timeouts and closes once", async () => {
  const client = createCodexAppServerClient({
    executable: process.execPath,
    args: [SHIM, "app-server"],
    timeoutMs: 20,
  });
  await rejects(() => client.request("unknown-method", {}, { requestTimeoutMs: 20 }), /timed out|exited/);
  client.close();
  client.close();
  equal(client.diagnostics.closed, true);
});

test("Codex exit classification returns the canonical run result", () => {
  deepEqual(classifyCodexExit({ code: 0 }, {
    provider: "codex", model: "gpt-5-codex", output: "ok", terminal: true,
  }, { model: "gpt-5-codex" }), {
    provider: "codex", model: "gpt-5-codex", output: "ok", terminal: true,
  });
});
