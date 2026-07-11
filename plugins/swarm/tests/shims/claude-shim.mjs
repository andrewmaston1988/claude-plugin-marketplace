// Fake `claude` for tests. Records what it was invoked with, then behaves per env:
//   SWARM_SHIM_LOG       path to a JSONL file; each invocation appends
//                        { argv, env: {ANTHROPIC_*}, cwd }
//   SWARM_SHIM_OUTPUT    stdout to emit (default "shim-ok")
//   SWARM_SHIM_EXIT      exit code (default 0)
//   SWARM_SHIM_SLEEP_MS  delay before exiting (for timeout/concurrency tests)
//   SWARM_SHIM_STREAM    emit stream-json events (assistant usage + result
//                        wrapping SWARM_SHIM_OUTPUT) like the real CLI
import { appendFileSync } from "node:fs";

const envSubset = {};
for (const k of Object.keys(process.env)) {
  if (k.startsWith("ANTHROPIC_") || k === "CORRELATION_ID") envSubset[k] = process.env[k];
}

if (process.env.SWARM_SHIM_LOG) {
  appendFileSync(
    process.env.SWARM_SHIM_LOG,
    JSON.stringify({ argv: process.argv.slice(2), env: envSubset, cwd: process.cwd() }) + "\n",
  );
}

const sleepMs = parseInt(process.env.SWARM_SHIM_SLEEP_MS || "0", 10);
if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));

const text = process.env.SWARM_SHIM_OUTPUT ?? "shim-ok";
if (process.env.SWARM_SHIM_STREAM) {
  const usage = { input_tokens: 1200, output_tokens: 300 };
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "shim-session" }) + "\n");
  process.stdout.write(JSON.stringify({ type: "assistant", message: { id: "m1", role: "assistant", usage } }) + "\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, usage, total_cost_usd: 0.01, num_turns: 1 }) + "\n");
} else {
  process.stdout.write(text);
}
process.exit(parseInt(process.env.SWARM_SHIM_EXIT || "0", 10));
