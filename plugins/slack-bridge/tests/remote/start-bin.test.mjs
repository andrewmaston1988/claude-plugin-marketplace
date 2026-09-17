// `start` wires the remote-control subsystem through the REAL bin path: the
// logger createLogger returns is an object, while createBrokerClient /
// createControlServer call log(msg, extra) as plain functions. 176 unit tests
// injected mocks and never caught the daemon passing the object bare — no other
// test spawns `start`, so a TypeError in the cold-start wiring was invisible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const binPath = fileURLToPath(new URL("../../bin/claude-slack.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bind-then-release: a port nothing else holds right now, so a stray daemon
// from an aborted run can't collide with this one.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// `claude-slack start --config <tmp>` with remote.controlToken set: the daemon
// must self-heal a broker, bring the control endpoint up, and stay alive. The
// spawned broker must have read the SAME config (--config threading) or it
// either 401s every authed call or, on a different config with no token,
// guards nothing.
test("start with controlToken wires remote control and stays up", async (t) => {
  const brokerPort = await freePort();
  const controlPort = await freePort();
  const token = `test-token-${Math.random().toString(36).slice(2)}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "start-bin-"));
  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    tokens: { bot: "xoxb-not-real", app: "xapp-not-real" },
    claude: { cwd: tmp },
    remote: { controlToken: token, brokerPort, controlPort },
  }));

  let stderr = "";
  const child = spawn(process.execPath, [binPath, "start", "--config", configPath], {
    env: {
      ...process.env, APPDATA: tmp, LOCALAPPDATA: tmp,
      // config.mjs overrides tokens from the environment — blank them, or this
      // child would run against the DEVELOPER'S live Slack workspace.
      SLACK_BOT_TOKEN: "", SLACK_APP_TOKEN: "", CLAUDE_CWD: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  t.after(async () => {
    // Correct-token shutdown: a broker left behind keeps the port band dirty.
    try {
      await fetch(`http://127.0.0.1:${brokerPort}/shutdown`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
    } catch {}
    try { child.kill(); } catch {}
    await sleep(150);
  });

  // The broker self-heal must run (broken logger wiring dies before spawnBroker).
  let healthy = false;
  for (let i = 0; i < 40 && !healthy; i++) {
    await sleep(200);
    try {
      const res = await fetch(`http://127.0.0.1:${brokerPort}/health`, { signal: AbortSignal.timeout(500) });
      healthy = res.ok;
    } catch {}
  }
  assert.ok(healthy, "daemon start must self-heal a broker on the configured port");

  // The control endpoint listens right after ensureBroker returns. Its token
  // guard covers every route, /health included (secure-by-default).
  let controlUp = false;
  for (let i = 0; i < 15 && !controlUp; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${controlPort}/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(500),
      });
      controlUp = res.ok;
    } catch {}
    if (!controlUp) await sleep(200);
  }
  assert.ok(controlUp, "daemon start must bring the control endpoint up");

  // Wrong Bearer → 401: pins that the SELF-SPAWNED broker read this config's
  // token. Without --config threading it runs on the default config (no token
  // under the test's APPDATA) and guards nothing — 200 for any caller.
  const wrong = await fetch(`http://127.0.0.1:${brokerPort}/list-peers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer not-${token}` },
    body: JSON.stringify({ scope: "machine", cwd: "", git_root: null, include_adhoc: true }),
    signal: AbortSignal.timeout(1000),
  });
  assert.equal(wrong.status, 401, "a wrong bearer token must be rejected by the spawned broker");

  // The wiring must not have crashed on the logger-object/function mismatch.
  assert.ok(!stderr.includes("log is not a function"), `start must not die on logger wiring; stderr: ${stderr.trim()}`);
  assert.ok(child.exitCode === null, "the daemon must still be running after wiring (fake Slack tokens only fail authTest, which is caught)");
});