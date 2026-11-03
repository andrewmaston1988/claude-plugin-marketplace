// Shared harness for the broker test files: a real broker on an ephemeral port
// and the HTTP helpers the tests drive it with. Fake-free — the broker is the
// unit under test; nothing here touches the network beyond 127.0.0.1.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBroker } from "../../src/remote/broker.mjs";

export function tmpState() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "slack-remote-broker-")), "state.json");
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startBroker(t, opts = {}) {
  const broker = createBroker({ stateFile: opts.stateFile ?? tmpState(), ...opts });
  t.after(() => broker.close());
  const port = await broker.listen(0);
  const call = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { broker, port, call };
}

export const REG = { pid: process.pid, cwd: "C:/work/a", git_root: "C:/work/a", tty: null, summary: "live session" };

// A session holding a claim on that broker, as its hooks find it on disk. Returns
// the env that points a spawned entry at it.
export function claimedSession(t, { port, peer, sid }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claimed-session-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, "claude-slack");
  fs.mkdirSync(path.join(stateDir, "remote-sessions"), { recursive: true });
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    tokens: { bot: "x", app: "x" }, claude: { cwd: dir }, remote: { brokerPort: port },
  }));
  fs.writeFileSync(path.join(stateDir, "remote-sessions", sid + ".json"), JSON.stringify({ peerId: peer, configPath }));
  return { LOCALAPPDATA: dir, XDG_STATE_HOME: dir, HOME: dir, USERPROFILE: dir };
}

// Async only: the broker runs in this process, so a sync spawn would block the
// port the entry dials.
export function runEntry(args, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}
