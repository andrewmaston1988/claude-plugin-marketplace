// Runs a plugin entry point as Claude Code does: JSON on stdin, output collected.
// Async only: a broker in the test process must keep serving the port the entry
// dials. The child rides on the promise, so a test can kill a waiter that never
// leaves. No plugin imports: the lifecycle gate loads this beside another ref's tree.
import { spawn } from "node:child_process";

export function runEntry(args, env, input) {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const done = new Promise((resolve) => {
    child.on("error", (e) => resolve({ status: -1, stdout, stderr: String(e) }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  child.stdin.end(JSON.stringify(input));
  return Object.assign(done, { child });
}
