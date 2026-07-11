import { chmodSync } from "node:fs";
import { join, delimiter } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CLI = fileURLToPath(new URL("../../scripts/swarm.mjs", import.meta.url));
export const SHIMS = fileURLToPath(new URL("../shims", import.meta.url));

// POSIX shim needs the exec bit; harmless no-op on Windows.
try { chmodSync(join(SHIMS, "claude"), 0o755); } catch { /* windows */ }

export function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
    env: {
      ...process.env,
      PATH: SHIMS + delimiter + process.env.PATH,
      Path: SHIMS + delimiter + (process.env.Path || process.env.PATH),
      ...env,
    },
  });
}

// Async variant for tests that host a stub HTTP server in THIS process:
// spawnSync would block the event loop and the server could never respond.
export function runCliAsync(args, { cwd, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        PATH: SHIMS + delimiter + process.env.PATH,
        Path: SHIMS + delimiter + (process.env.Path || process.env.PATH),
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
