// Fake `claude` for tests. Records what it was invoked with, then behaves per env:
//   SWARM_SHIM_LOG       path to a JSONL file; each invocation appends
//                        { argv, env: {ANTHROPIC_*}, cwd }
//   SWARM_SHIM_OUTPUT    stdout to emit (default "shim-ok")
//   SWARM_SHIM_EXIT      exit code (default 0)
//   SWARM_SHIM_SLEEP_MS  delay before exiting (for timeout/concurrency tests)
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

process.stdout.write(process.env.SWARM_SHIM_OUTPUT ?? "shim-ok");
process.exit(parseInt(process.env.SWARM_SHIM_EXIT || "0", 10));
