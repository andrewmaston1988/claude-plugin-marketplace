// C1: uncaughtException/unhandledRejection are registered FIRST in the serve
// branch (D4b, amended dash-ar-1) -- before the pre-listen pid write and the
// listen/bind handling -- so a crash in the bind/takeover window is caught
// too. Drives the REAL registered handler in a spawned serve child via the
// test-only SWARM_SERVE_TEST_CRASH trigger, never calling the handler directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const SWARM_MJS = fileURLToPath(new URL("../scripts/swarm.mjs", import.meta.url));

function tmpHome() {
  const home = mkdtempSync(join(tmpdir(), "swarm-crash-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    disable1mContext: true,
    dashboard: { enabled: true, port: 0, bind: "127.0.0.1", tray: false, autoRestartOnUpdate: false },
  }), "utf8");
  return home;
}

function runServeCrash(home, trigger) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SWARM_MJS, "serve"], {
      env: { ...process.env, SWARM_HOME: home, SWARM_SERVE_TEST_CRASH: trigger },
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      reject(new Error(`serve (trigger=${trigger}) did not exit within timeout; stderr: ${stderr}`));
    }, 15000);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

for (const trigger of ["after-listen", "before-listen"]) {
  test(`serve crash (${trigger}): the registered uncaughtException handler logs, exits non-zero, and keeps the pid record`, async () => {
    const home = tmpHome();
    try {
      const { code } = await runServeCrash(home, trigger);
      assert.notEqual(code, 0, "a crash must exit non-zero");
      const log = readFileSync(join(home, "dashboard.log"), "utf8");
      const lines = log.trim().split("\n").map((l) => JSON.parse(l));
      const crash = lines.find((l) => l.event === "crash");
      assert.ok(crash, `expected a crash line in dashboard.log, got: ${log}`);
      assert.match(crash.msg, /SWARM_SERVE_TEST_CRASH/);
      assert.ok(existsSync(join(home, "dashboard.pid")), "the pid record must survive a crash -- that is how the tray tells a crash from a deliberate stop");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
