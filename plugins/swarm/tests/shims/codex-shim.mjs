// Fake `codex` for adapter tests. It implements the two JSONL surfaces used by
// Covers app-server stdio and `codex exec --json`.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const env = process.env;

if (env.SWARM_SHIM_LOG) {
  appendFileSync(env.SWARM_SHIM_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + "\n");
}

function send(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function validateExecArgv() {
  const resumeIndex = argv.indexOf("resume");
  if (resumeIndex < 0) return;
  const unsupported = argv.slice(resumeIndex + 1).find((value) => value === "--sandbox" || value === "--add-dir");
  if (unsupported) {
    process.stderr.write(`unsupported resume option: ${unsupported}\n`);
    process.exit(2);
  }
}

if (argv.includes("app-server")) {
  const page = env.SWARM_CODEX_SHIM_PAGE || "single";
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "codex-shim", version: "test" } } });
      return;
    }
    if (message.method === "model/list") {
      const cursor = message.params?.cursor;
      if (page === "paged" && !cursor) {
        send({ jsonrpc: "2.0", id: message.id, result: { data: [{ id: "gpt-5-codex" }], nextCursor: "page-2" } });
      } else {
        send({ jsonrpc: "2.0", id: message.id, result: { data: [{ id: "gpt-5-codex" }, { id: "gpt-5-mini" }], nextCursor: null } });
      }
      return;
    }
    if (message.method === "account/rateLimits/read") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        rateLimitsByLimitId: {
          five_hour: { limitName: "Five hour", primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 123 }, secondary: null },
          weekly: { limitName: "Weekly", primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 456 }, secondary: { usedPercent: 1, resetsAt: 789 } },
        },
      } });
      return;
    }
    if (message.method === "account/usage/read") {
      send({ jsonrpc: "2.0", id: message.id, result: { summary: { inputTokens: 10, outputTokens: 2 }, dailyUsageBuckets: [{ date: "2026-09-19", inputTokens: 10 }] } });
      return;
    }
    if (message.method === "unknown-method") return;
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  });
  process.stdin.resume();
} else if (argv.includes("exec")) {
  validateExecArgv();
  const text = env.SWARM_CODEX_SHIM_OUTPUT || "codex-shim-ok";
  send({ type: "thread.started", thread_id: "shim-thread" });
  send({ type: "item.completed", item: { id: "reasoning-1", type: "reasoning", text: "shim reasoning" } });
  send({ type: "item.completed", item: { id: "message-1", type: "agent_message", text } });
  if (env.SWARM_CODEX_SHIM_FAIL) send({ type: "turn.failed", error: { code: "shim_failure", message: env.SWARM_CODEX_SHIM_FAIL } });
  else send({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 5, cached_input_tokens: 3 }, model: "gpt-5-codex" });
  process.exit(parseInt(env.SWARM_SHIM_EXIT || "0", 10));
} else {
  process.exit(2);
}
