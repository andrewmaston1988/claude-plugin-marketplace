import { chmodSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CLI = fileURLToPath(new URL("../../scripts/swarm.mjs", import.meta.url));
export const SHIMS = fileURLToPath(new URL("../shims", import.meta.url));

// POSIX shim needs the exec bit; harmless no-op on Windows.
try { chmodSync(join(SHIMS, "claude"), 0o755); } catch { /* windows */ }
try { chmodSync(join(SHIMS, "codex"), 0o755); } catch { /* windows */ }

// Writes a throwaway config carrying `quotaPreflight` unless the caller pinned
// SWARM_CONFIG itself. Returns the dir so the caller can remove it when the child exits.
function configOverlay(env, quotaPreflight) {
  const childEnv = { ...env };
  if (childEnv.SWARM_CONFIG !== undefined) return { configDir: undefined, childEnv };
  const configDir = mkdtempSync(join(tmpdir(), "swarm-cli-config-"));
  const configPath = join(configDir, "config.json");
  const sourcePath = childEnv.SWARM_HOME && join(childEnv.SWARM_HOME, "config.json");
  const source = sourcePath && existsSync(sourcePath) ? JSON.parse(readFileSync(sourcePath, "utf8")) : {};
  writeFileSync(configPath, JSON.stringify({ ...source, quotaPreflight }), "utf8");
  childEnv.SWARM_CONFIG = configPath;
  return { configDir, childEnv };
}

export function runCli(args, { cwd, env = {}, quotaPreflight = false } = {}) {
  const { configDir, childEnv } = configOverlay(env, quotaPreflight);
  try {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      windowsHide: true,
      env: {
        ...process.env,
        PATH: SHIMS + delimiter + process.env.PATH,
        Path: SHIMS + delimiter + (process.env.Path || process.env.PATH),
        // Pin the append-only stdout contract: the suite may itself be running
        // inside a repainting harness, whose CLAUDECODE would otherwise leak in.
        SWARM_REPAINT: "0",
        ...childEnv,
      },
    });
  } finally {
    if (configDir) rmSync(configDir, { recursive: true, force: true });
  }
}

// Async variant for tests that host a stub HTTP server in THIS process:
// spawnSync would block the event loop and the server could never respond.
export function runCliAsync(args, { cwd, env = {}, quotaPreflight = false } = {}) {
  const { configDir, childEnv } = configOverlay(env, quotaPreflight);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        PATH: SHIMS + delimiter + process.env.PATH,
        Path: SHIMS + delimiter + (process.env.Path || process.env.PATH),
        SWARM_REPAINT: "0",
        ...childEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => {
      if (configDir) rmSync(configDir, { recursive: true, force: true });
      resolve({ status, stdout, stderr });
    });
  });
}
