// `remote-mcp` must come up through the real bin wiring — a wiring defect (the
// bin-built logger shape, a missing import) kills every spawn before registration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const binPath = fileURLToPath(new URL("../../bin/claude-slack.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("remote-mcp registers with the broker and answers the MCP handshake", async (t) => {
  const port = 8000 + Math.floor(Math.random() * 100);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-bin-"));
  const cfgPath = path.join(tmp, "config.json");
  const token = `tok-${port}`;
  fs.writeFileSync(cfgPath, JSON.stringify({
    tokens: { bot: "xoxb-test", app: "xapp-test" },
    claude: { cwd: tmp },
    remote: { controlToken: token, brokerPort: port, controlPort: port + 1, pollIntervalMs: 60_000, heartbeatIntervalMs: 120_000 },
  }));
  const env = { ...process.env, APPDATA: tmp, LOCALAPPDATA: tmp };

  const broker = spawn(process.execPath, [binPath, "broker", "run", "--config", cfgPath, "--port", String(port)], {
    env, stdio: "ignore", windowsHide: true,
  });
  const mcp = spawn(process.execPath, [binPath, "remote-mcp", "--config", cfgPath], {
    env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  t.after(async () => {
    try { await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) }); } catch {}
    try { mcp.kill(); } catch {}
    try { broker.kill(); } catch {}
    await sleep(150);
  });

  let out = "";
  mcp.stdout.setEncoding("utf8");
  mcp.stdout.on("data", (c) => { out += c; });
  let err = "";
  mcp.stderr.setEncoding("utf8");
  mcp.stderr.on("data", (c) => { err += c; });

  let healthy = false;
  for (let i = 0; i < 30 && !healthy; i++) {
    await sleep(200);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      healthy = res.ok;
    } catch {}
  }
  assert.ok(healthy, "broker run must come up healthy within 6s");

  mcp.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  mcp.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n');

  const responses = {};
  for (let i = 0; i < 50 && !(responses[1] && responses[2]); i++) {
    await sleep(200);
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.id === 1 || o.id === 2) responses[o.id] = o;
      } catch { /* partial line — next chunk completes it */ }
    }
    if (mcp.exitCode !== null) break;
  }
  assert.equal(mcp.exitCode, null, `remote-mcp must stay alive through the handshake, died with stderr: ${err}`);
  assert.ok(responses[1]?.result, `initialize must answer, stderr: ${err}, stdout: ${out}`);
  assert.equal(responses[1].result.serverInfo?.name, "slack-bridge-remote");
  const names = (responses[2]?.result?.tools ?? []).map((tool) => tool.name);
  assert.ok(
    names.includes("slack_seize") && names.includes("slack_post") && names.includes("check_messages"),
    `tools/list must expose the remote tools, got: ${names.join(", ")}`
  );

  // registration: the peer must appear in the broker (start() may still be
  // mid-register when the handshake answered, so poll briefly)
  let registered = false;
  for (let i = 0; i < 25 && !registered; i++) {
    await sleep(200);
    const res = await fetch(`http://127.0.0.1:${port}/list-peers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ scope: "machine", cwd: "", git_root: null, include_adhoc: true }),
    }).catch(() => null);
    if (res?.ok) {
      const peers = await res.json();
      registered = peers.some((p) => p.summary === "slack-bridge remote");
    }
  }
  assert.ok(registered, `remote-mcp must register as a peer, stderr: ${err}`);
});