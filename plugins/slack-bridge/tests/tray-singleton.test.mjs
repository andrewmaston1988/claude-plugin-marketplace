// Every `start --daemon` and every logon autostart spawned a tray with no check
// for a live one — about 10 accumulated in one session. windows.ps1 now holds a
// named mutex keyed on the PID file, and a second tray exits on startup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const trayScript = fileURLToPath(new URL("../src/tray/windows.ps1", import.meta.url));
const binPath = fileURLToPath(new URL("../bin/claude-slack.mjs", import.meta.url));

const shell = ["pwsh", "powershell"].find((exe) =>
  spawnSync(exe, ["-NoProfile", "-Command", "exit 0"], { windowsHide: true }).status === 0);

function printMutexName(pidFile) {
  const r = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-File", trayScript,
    "-PidFile", pidFile, "-PrintMutexName"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  assert.equal(r.status, 0, `-PrintMutexName exited ${r.status}; stderr: ${r.stderr}`);
  return r.stdout.trim();
}

test("mutex name is the sha256 of the lowercased full PID path, stable across spellings",
  { skip: shell ? false : "no PowerShell on PATH" }, () => {
    const base = process.platform === "win32" ? "C:\\X\\claude-slack.pid" : "/tmp/X/claude-slack.pid";
    const variant = process.platform === "win32" ? "c:/x/CLAUDE-SLACK.PID" : "/tmp/x/CLAUDE-SLACK.PID";
    const expected = "Local\\claude-slack-tray-"
      + createHash("sha256").update(path.resolve(base).toLowerCase(), "utf8").digest("hex").slice(0, 16);

    assert.equal(printMutexName(base), expected);
    assert.equal(printMutexName(variant), expected);
    assert.notEqual(printMutexName(base.replace("claude-slack.pid", "other.pid")), expected);
  });

test("a tray started without -PidFile refuses rather than sharing a hashless mutex name",
  { skip: shell ? false : "no PowerShell on PATH" }, () => {
    const r = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-File", trayScript, "-PrintMutexName"],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    assert.notEqual(r.status, 0, `expected a non-zero exit, got ${r.status}; stdout: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /claude-slack-tray-\s*$/);
  });

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
