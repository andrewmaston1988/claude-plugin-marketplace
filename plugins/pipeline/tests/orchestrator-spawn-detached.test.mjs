// Verify detached+unref child processes survive parent exit (Windows job-object fix).
import { test } from "node:test";
import { ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── structural: both spawn blocks use detached:true ───────────────────────────

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const spawnSrc = readFileSync(
  resolve(__dir, "../scripts/orchestrator/spawn.mjs"),
  "utf8",
);

test("session spawn block sets detached:true", () => {
  // Match the specific spawn() call options block for the session spawn.
  // The block has cwd, env, windowsHide, detached, stdio on consecutive lines.
  const sessionBlock = spawnSrc.match(
    /spawn\(spawnCmd[\s\S]*?cwd:[\s\S]*?detached:\s*(true|false)/,
  );
  ok(sessionBlock, "session spawn block not found");
  strictEqual(sessionBlock[1], "true", "session spawn block must use detached:true");
});

test("merge spawn block sets detached:true", () => {
  // The merge spawn() block is on one line: cwd: projectRoot, env, windowsHide, detached, stdio.
  const mergeBlock = spawnSrc.match(
    /spawn\(spawnCmd[\s\S]*?cwd: projectRoot[\s\S]*?detached:\s*(true|false)/,
  );
  ok(mergeBlock, "merge spawn block not found");
  strictEqual(mergeBlock[1], "true", "merge spawn block must use detached:true");
});

// ── behavioural: detached child survives parent exit ─────────────────────────
// Write a helper script to a temp file, spawn it, wait 1 s, check PID alive.

const HELPER_SCRIPT = `
const { spawn } = require("child_process");
// Spawn a long-running grandchild with detached:true + unref
const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
  detached: true,
  stdio: "ignore",
});
child.unref();
// Report grandchild PID so the outer test can check it
process.stdout.write(String(child.pid) + "\\n");
// Exit immediately — this simulates orchestrator death
process.exit(0);
`;

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid) {
  try { process.kill(pid); } catch { /* already dead */ }
}

test("detached+unref child survives parent exit", async () => {
  const helperPath = join(tmpdir(), `spawn-detach-helper-${process.pid}.cjs`);
  writeFileSync(helperPath, HELPER_SCRIPT, "utf8");
  try {
    const result = spawnSync(process.execPath, [helperPath], { encoding: "utf8", timeout: 5000 });
    ok(result.status === 0, `helper exited non-zero: ${result.stderr}`);
    const childPid = parseInt(result.stdout.trim(), 10);
    ok(!isNaN(childPid), `expected numeric PID, got: ${result.stdout.trim()}`);
    // Give the child a moment to get scheduled — 200 ms is ample.
    await new Promise((r) => setTimeout(r, 200));
    const alive = pidAlive(childPid);
    // Clean up regardless of assertion outcome
    if (alive) killPid(childPid);
    ok(alive, `child PID ${childPid} was not alive after parent exited — detached+unref may not be working`);
  } finally {
    if (existsSync(helperPath)) rmSync(helperPath);
  }
});
