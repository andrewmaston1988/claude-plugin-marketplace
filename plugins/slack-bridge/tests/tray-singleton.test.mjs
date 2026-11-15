// Every `start --daemon` and every logon autostart spawned a tray with no check
// for a live one — about 10 accumulated in one session. windows.ps1 now holds a
// named mutex keyed on the PID file, and a second tray exits on startup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const trayScript = fileURLToPath(new URL("../src/tray/windows.ps1", import.meta.url));

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

// The live-tray singleton case lives in tray-singleton.win.test.mjs.
