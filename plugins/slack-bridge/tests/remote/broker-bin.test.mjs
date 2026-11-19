// `broker run` is what remote-mcp and the bridge both self-heal against, so an
// instant bin death takes remote control down with it — no other test spawns the real bin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const binPath = fileURLToPath(new URL("../../bin/claude-slack.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// This test is the only one that starts the real bin, and the broker it starts
// is a child of the test process: nothing else will ever reap it, so every exit
// path has to, and has to wait for the exit rather than assume the kill landed.
async function reap(child) {
  try { child.kill(); } catch {}
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(2000).then(() => false),
  ]);
  if (!exited) {
    try { child.kill("SIGKILL"); } catch {}
    await Promise.race([new Promise((r) => child.once("exit", r)), sleep(2000)]);
  }
}

test("broker run comes up healthy on its port", async (t) => {
  const port = 7900 + Math.floor(Math.random() * 100);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "broker-bin-"));
  const child = spawn(process.execPath, [binPath, "broker", "run", "--port", String(port)], {
    env: { ...process.env, APPDATA: tmp, LOCALAPPDATA: tmp },
    stdio: "ignore",
    windowsHide: true,
  });
  t.after(async () => {
    try { await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", signal: AbortSignal.timeout(1000) }); } catch {}
    await reap(child);
  });

  let healthy = false;
  for (let i = 0; i < 30 && !healthy; i++) {
    await sleep(200);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      healthy = res.ok;
    } catch {}
  }
  assert.ok(healthy, "broker run must come up healthy within 6s (it dies instantly on a pid-helper mismatch)");
});
