// An unknown subcommand used to fall through to `start`: a hook naming a
// subcommand the installed bin predates (`stop-hook` against a stale plugin
// cache) launched a full bridge per hook fire — 50 never-exiting daemons, each
// clobbering the pid file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPaths } from "../src/paths.mjs";

const binPath = fileURLToPath(new URL("../bin/claude-slack.mjs", import.meta.url));

const tmpEnv = (tmp) => ({
  APPDATA: tmp, LOCALAPPDATA: tmp,
  XDG_CONFIG_HOME: tmp, XDG_DATA_HOME: tmp, XDG_STATE_HOME: tmp, HOME: tmp,
});

function runBin(args, tmp, { input } = {}) {
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(process.execPath, [binPath, ...args], {
      env: { ...process.env, ...tmpEnv(tmp), SLACK_BOT_TOKEN: "", SLACK_APP_TOKEN: "", CLAUDE_CWD: "" },
      stdio: [input === undefined ? "ignore" : "pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    if (input !== undefined) child.stdin.end(input);
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    // A fallthrough to `start` never exits on a loadable config — kill it so
    // the assertion reports the defect instead of hanging the suite.
    const timer = setTimeout(() => child.kill(), 5000);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

test("unknown subcommand exits 2 with a usage error instead of starting the bridge", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bin-unknown-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // A loadable config, so a fallthrough to `start` would get as far as the bridge.
  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    tokens: { bot: "xoxb-not-real", app: "xapp-not-real" },
    claude: { cwd: tmp },
  }));

  const { code, stderr } = await runBin(["no-such-subcommand", "--config", configPath], tmp);
  assert.equal(code, 2, `expected exit 2, got ${code}; stderr: ${stderr}`);
  assert.match(stderr, /unknown command "no-such-subcommand"/);
  const pidFiles = fs.readdirSync(tmp, { recursive: true }).filter((f) => String(f).endsWith("claude-slack.pid"));
  assert.deepEqual(pidFiles, [], "an unknown subcommand must never write the bridge pid file");
});

test("wait is no longer a subcommand: the model never runs a waiter itself", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bin-unknown-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const { code, stderr } = await runBin(["wait", "--peer", "p1"], tmp);
  assert.equal(code, 2, stderr);
  assert.match(stderr, /unknown command "wait"/);
});

// The stateDir the bin resolves under tmpEnv(tmp), on whatever platform runs this.
function stateDirFor(tmp) {
  const saved = { ...process.env };
  Object.assign(process.env, tmpEnv(tmp));
  try { return getPaths().stateDir; } finally {
    for (const k of Object.keys(tmpEnv(tmp))) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; }
  }
}

test("rewake-hook on an unclaimed session exits 0", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bin-rewake-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const { code, stderr } = await runBin(["rewake-hook"], tmp, { input: JSON.stringify({ session_id: "nobody", hook_event_name: "Stop" }) });
  assert.equal(code, 0, stderr);
});

test("rewake-hook exits with the waiter's code: a broker that 401s wakes the session with WAIT FAILED", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bin-rewake-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const broker = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", lease: true, single_flight: true }));
    }
    req.resume();
    req.on("end", () => { res.writeHead(401); res.end("unauthorized"); });
  });
  await new Promise((r) => broker.listen(0, "127.0.0.1", r));
  t.after(() => broker.close());
  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    tokens: { bot: "xoxb-not-real", app: "xapp-not-real" },
    claude: { cwd: tmp },
    remote: { brokerPort: broker.address().port, controlToken: "wrong" },
  }));
  const sessions = path.join(stateDirFor(tmp), "remote-sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "sess-1.json"), JSON.stringify({ peerId: "p1", configPath, channel: "C1" }));

  const { code, stderr } = await runBin(["rewake-hook"], tmp, { input: JSON.stringify({ session_id: "sess-1", hook_event_name: "Stop" }) });
  assert.equal(code, 2, stderr);
  assert.match(stderr, /^WAIT FAILED: /m);
});
