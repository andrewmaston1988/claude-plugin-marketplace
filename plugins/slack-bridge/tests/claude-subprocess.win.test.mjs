// The Windows half of the process-tree kill: a cmd.exe wrapper holding a node
// grandchild must leave no live grandchild behind.
//
// Its own file so the diff-aware Windows run always exercises it, not only when
// something in claude-subprocess.test.mjs's closure changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { killProcessTree } from "../src/core/claude-subprocess.mjs";

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Generous: the suite runs every file at once, and cmd.exe plus node can take
// seconds to start on a loaded box.
async function poll(pred, message, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = pred();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// The real shape on Windows: cmd.exe holds the session and a node grandchild does
// the work. child.kill reaps only cmd.exe, leaving the grandchild running.
test("the Windows tree kill leaves no live grandchild", {
  skip: process.platform !== "win32" ? "windows-only process tree" : false,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-tree-kill-"));
  const pidFile = path.join(dir, "grandchild.pid");
  const sleeper = path.join(dir, "sleeper.mjs");
  fs.writeFileSync(sleeper, [
    'import fs from "node:fs";',
    "fs.writeFileSync(process.argv[2], String(process.pid));",
    "setTimeout(() => {}, 60_000);",
  ].join("\n"));
  const wrapper = spawn("cmd.exe", ["/d", "/s", "/c", "node", sleeper, pidFile], { stdio: "ignore", windowsHide: true });
  let grandchild = null;
  try {
    grandchild = await poll(
      () => { try { return Number(fs.readFileSync(pidFile, "utf8")) || 0; } catch { return 0; } },
      "the grandchild never reported its PID",
    );
    assert.equal(isAlive(grandchild), true, "the grandchild should be running before the kill");

    killProcessTree(wrapper);

    await poll(() => !isAlive(grandchild), "the grandchild outlived the tree kill");
  } finally {
    if (grandchild) { try { process.kill(grandchild); } catch { /* already gone */ } }
    try { wrapper.kill(); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
