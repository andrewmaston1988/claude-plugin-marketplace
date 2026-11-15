// The live-tray half of the singleton guard: a second tray on the same PID file
// must exit 0 and leave the first running.
//
// Its own file so the diff-aware Windows run always exercises it, not only when
// something in tray-singleton.test.mjs's closure changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const trayScript = fileURLToPath(new URL("../src/tray/windows.ps1", import.meta.url));
const binPath = fileURLToPath(new URL("../bin/claude-slack.mjs", import.meta.url));

function launchTray(tmp) {
  return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
    "-File", trayScript,
    "-PidFile", path.join(tmp, "claude-slack.pid"),
    "-EntryPath", binPath,
    "-ConfigPath", path.join(tmp, "config.json"),
    "-NodeExe", process.execPath,
  ], { stdio: "ignore", windowsHide: true });
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Opt-in: a real tray puts an icon on the operator's desktop for the run.
test("a second tray on the same PID file exits 0 and leaves the first running", {
  skip: process.platform !== "win32" ? "windows-only tray"
    : process.env.SLACK_TRAY_TEST !== "1" ? "opt-in: SLACK_TRAY_TEST=1 (shows a real tray icon)"
    : false,
}, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tray-singleton-"));
  const first = launchTray(tmp);
  let second = null;
  t.after(() => {
    for (const p of [first, second]) if (p && isAlive(p.pid)) p.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await new Promise((r) => setTimeout(r, 3000));
  assert.ok(isAlive(first.pid), "first tray died on its own before the second launched");

  second = launchTray(tmp);
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { second.kill(); resolve("timeout"); }, 10_000);
    second.on("exit", (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(code, 0, `second tray must exit 0 within 10 s, got ${code}`);
  assert.ok(isAlive(first.pid), "first tray must keep running");
});
