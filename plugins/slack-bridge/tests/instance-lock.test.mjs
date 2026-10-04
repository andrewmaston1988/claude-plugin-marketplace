// Nothing stopped a second `start` from running beside a live bridge — two
// bridges double-answered every Slack message and fought over the PID file.
// The bridge now holds an OS-level lock (named pipe / unix socket) per stateDir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { acquireInstanceLock, lockPath, probeInstance } from "../src/instance-lock.mjs";

const binPath = fileURLToPath(new URL("../bin/claude-slack.mjs", import.meta.url));

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a second acquire on one stateDir is refused; release frees it", async (t) => {
  const stateDir = tmpDir(t, "lock-");
  const first = await acquireInstanceLock({ stateDir });
  await assert.rejects(acquireInstanceLock({ stateDir }), (e) => e.code === "ALREADY_RUNNING");
  await first.release();
  const again = await acquireInstanceLock({ stateDir });
  await again.release();
});

test("probeInstance: a held lock answers, an absent one does not", async (t) => {
  const stateDir = tmpDir(t, "probe-");
  assert.equal(await probeInstance({ stateDir }), false);
  const lock = await acquireInstanceLock({ stateDir });
  assert.equal(await probeInstance({ stateDir }), true);
  await lock.release();
});

// Refusing a start is recoverable; reclaiming a slow live bridge's socket is not.
test("probeInstance: a connect that never resolves counts as alive", async () => {
  const silent = Object.assign(new EventEmitter(), { destroy() {} });
  assert.equal(await probeInstance({ stateDir: "unused", _net: { connect: () => silent } }), true);
});

test("different stateDirs lock independently", async (t) => {
  const a = await acquireInstanceLock({ stateDir: tmpDir(t, "lock-a-") });
  const b = await acquireInstanceLock({ stateDir: tmpDir(t, "lock-b-") });
  await a.release();
  await b.release();
});

test("the Windows pipe name ignores case in the stateDir path",
  { skip: process.platform !== "win32" ? "windows pipe naming" : false }, () => {
    assert.equal(lockPath("C:\\Users\\X\\claude-slack"), lockPath("c:/users/x/CLAUDE-SLACK"));
    assert.match(lockPath("C:\\Users\\X\\claude-slack"), /^\\\\\.\\pipe\\claude-slack-[0-9a-f]{16}$/);
  });

// A crashed bridge leaves its socket file behind; nothing answers on it.
function leaveStaleSocket(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(lockPath(stateDir), "");
}

test("a stale unix socket is reclaimed",
  { skip: process.platform === "win32" ? "pipes vanish with their process" : false }, async (t) => {
    const stateDir = tmpDir(t, "lock-stale-");
    leaveStaleSocket(stateDir);
    const lock = await acquireInstanceLock({ stateDir });
    await lock.release();
  });

test("two concurrent reclaims of a stale socket yield exactly one holder",
  { skip: process.platform === "win32" ? "pipes vanish with their process" : false }, async (t) => {
    const stateDir = tmpDir(t, "lock-race-");
    leaveStaleSocket(stateDir);
    const results = await Promise.allSettled([
      acquireInstanceLock({ stateDir }), acquireInstanceLock({ stateDir }),
    ]);
    const held = results.filter((r) => r.status === "fulfilled");
    for (const r of held) await r.value.release();
    assert.equal(held.length, 1, `expected one holder, got ${held.length}`);
    assert.equal(results.find((r) => r.status === "rejected")?.reason.code, "ALREADY_RUNNING");
  });

function runBin(args, tmp) {
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(process.execPath, [binPath, ...args], {
      env: {
        ...process.env, APPDATA: tmp, LOCALAPPDATA: tmp,
        XDG_CONFIG_HOME: tmp, XDG_DATA_HOME: tmp, XDG_STATE_HOME: tmp, HOME: tmp,
        SLACK_BOT_TOKEN: "", SLACK_APP_TOKEN: "", CLAUDE_CWD: "",
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    // An unguarded `start` runs forever — a kill is reported as the defect.
    const timer = setTimeout(() => child.kill(), 10_000);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

test("`start` beside a live bridge exits 1 before writing a PID file or log", async (t) => {
  const tmp = tmpDir(t, "bin-lock-");
  const stateDir = process.platform === "darwin"
    ? path.join(tmp, "Library", "Application Support", "claude-slack")
    : path.join(tmp, "claude-slack");
  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    tokens: { bot: "xoxb-not-real", app: "xapp-not-real" },
    claude: { cwd: tmp },
  }));

  const held = await acquireInstanceLock({ stateDir });
  t.after(() => held.release());

  const { code, stderr } = await runBin(["start", "--config", configPath], tmp);
  assert.equal(code, 1, `expected exit 1, got ${code}; stderr: ${stderr}`);
  assert.match(stderr, /already running/);
  const files = fs.readdirSync(tmp, { recursive: true }).map(String);
  assert.deepEqual(files.filter((f) => f.endsWith("claude-slack.pid")), [], "no PID file");
  assert.deepEqual(files.filter((f) => f.endsWith(".log")), [], "no log file");
});
