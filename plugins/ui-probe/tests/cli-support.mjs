// Shared CLI harness: every invocation is a real child process, so the exit code and the
// loaded-module set are the ones a user gets.

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
export const PLUGIN = fileURLToPath(new URL("..", import.meta.url));
export const BIN = path.join(PLUGIN, "bin", "ui-probe.mjs");

// Async spawn, never spawnSync: the fixture server lives in this process's event loop, and a
// synchronous child would block it until every baseUrl check timed out.
export async function probe(args, { cwd = PLUGIN, hook = false, log = null, env: overrides = null } = {}) {
  // With a loader registered, Windows entry specifiers must be relative to the plugin root:
  // raw `C:\` paths die on ERR_UNSUPPORTED_ESM_URL_SCHEME and file:// URLs get cwd-joined.
  // Hook probes therefore run from PLUGIN and take --config explicitly.
  const argv = hook
    ? ["--import", "./tests/module-hook.mjs", "./bin/ui-probe.mjs", ...args]
    : [BIN, ...args];
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // A null override deletes the variable: that is how a test hides sdb from findSdb.
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value === null) delete env[name];
    else env[name] = value;
  }
  if (log) env.UI_PROBE_MODULE_LOG = log;
  try {
    const { stdout, stderr } = await execFile(process.execPath, argv, {
      cwd: hook ? PLUGIN : cwd,
      env,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr };
  } catch (e) {
    if (typeof e.code !== "number") throw e;
    return { status: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

export function scratchConfig(dir, config) {
  writeFileSync(path.join(dir, ".ui-probe.json"), JSON.stringify(config, null, 2));
}

export function scratchDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}
