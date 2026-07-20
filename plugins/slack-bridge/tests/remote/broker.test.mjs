// Forked/trimmed from plugins/claude-peers/tests/broker.test.mjs. The internal
// broker routes messages between the slack-bridge daemon (peer "slack-bridge")
// and a live interactive session's MCP server. Same wire protocol as claude-peers
// (distinct port: 7898, not 7899) so the battle-tested patterns carry over.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBroker } from "../../src/remote/broker.mjs";

function tmpState() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "slack-remote-broker-")), "state.json");
}

async function startBroker(t, opts = {}) {
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

const REG = { pid: process.pid, cwd: "C:/work/a", git_root: "C:/work/a", tty: null, summary: "live session" };

test("register assigns an 8-char id and the peer appears in list-peers", async (t) => {
  const { call } = await startBroker(t);
  const { body: reg } = await call("/register", REG);
  assert.match(reg.id, /^[a-z0-9]{8}$/);
  const { body: peers } = await call("/list-peers", { scope: "machine", cwd: "x", git_root: null });
  assert.equal(peers.length, 1);
  assert.equal(peers[0].id, reg.id);
});

test("heartbeat advances last_seen", async (t) => {
  let now = 1000;
  const { call } = await startBroker(t, { _now: () => new Date(now) });
  const { body: reg } = await call("/register", REG);
  now = 5000;
  await call("/heartbeat", { id: reg.id });
  const { body: peers } = await call("/list-peers", { scope: "machine", cwd: "x", git_root: null });
  assert.equal(peers[0].last_seen, new Date(5000).toISOString());
});

test("send-message to a registered peer queues; poll-messages delivers once; second poll empty", async (t) => {
  const { call } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  const sent = await call("/send-message", { from_id: a.id, to_id: b.id, text: "hello" });
  assert.equal(sent.body.ok, true);
  const first = await call("/poll-messages", { id: b.id });
  assert.deepEqual(first.body.messages.map((m) => m.text), ["hello"]);
  const second = await call("/poll-messages", { id: b.id });
  assert.equal(second.body.messages.length, 0);
});

// The daemon sends as the fixed id "slack-bridge" without ever calling /register.
// It must be auto-registered as an adhoc peer so the live session can reply to it.
test("send-message from an unknown sender (slack-bridge) auto-registers adhoc; reply routes back", async (t) => {
  const { call } = await startBroker(t);
  const { body: reg } = await call("/register", REG);
  const send = await call("/send-message", { from_id: "slack-bridge", to_id: reg.id, text: "from slack" });
  assert.equal(send.body.ok, true);
  const reply = await call("/send-message", { from_id: reg.id, to_id: "slack-bridge", text: "ack" });
  assert.equal(reply.body.ok, true, `reply failed: ${reply.body.error}`);
  const { body: polled } = await call("/poll-messages", { id: "slack-bridge" });
  assert.deepEqual(polled.messages.map((m) => m.text), ["ack"]);
});

test("dead peers are reaped on list-peers and their undelivered messages dropped", async (t) => {
  const dead = new Set();
  const _kill = (pid) => { if (dead.has(pid)) throw new Error("ESRCH"); };
  const { call } = await startBroker(t, { _kill });
  const { body: a } = await call("/register", { ...REG, pid: 111 });
  const { body: b } = await call("/register", { ...REG, pid: 222 });
  await call("/send-message", { from_id: b.id, to_id: a.id, text: "never delivered" });
  dead.add(111);
  const { body: peers } = await call("/list-peers", { scope: "machine", cwd: "x", git_root: null });
  assert.deepEqual(peers.map((p) => p.id), [b.id]);
});

test("unregister removes a peer", async (t) => {
  const { call } = await startBroker(t);
  const { body: reg } = await call("/register", REG);
  await call("/unregister", { id: reg.id });
  const { body: peers } = await call("/list-peers", { scope: "machine", cwd: "x", git_root: null });
  assert.equal(peers.length, 0);
});

test("a corrupt state file is quarantined loudly, not silently overwritten", async (t) => {
  const stateFile = tmpState();
  fs.writeFileSync(stateFile, "{ definitely not json");
  const logged = [];
  const broker = createBroker({ stateFile, log: (m) => logged.push(m) });
  t.after(() => broker.close());
  const port = await broker.listen(0);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.status, "ok");
  assert.ok(logged.some((m) => /corrupt/i.test(m)), "must log the quarantine");
  const quarantined = fs.readdirSync(path.dirname(stateFile)).filter((f) => f.includes("corrupt"));
  assert.equal(quarantined.length, 1, "corrupt file must be preserved, not deleted");
});

test("state survives a broker restart via the state file", async () => {
  const stateFile = tmpState();
  const b1 = createBroker({ stateFile });
  const port1 = await b1.listen(0);
  const reg = await (await fetch(`http://127.0.0.1:${port1}/register`, { method: "POST", body: JSON.stringify(REG) })).json();
  await b1.close();
  const b2 = createBroker({ stateFile });
  const port2 = await b2.listen(0);
  const peers = await (await fetch(`http://127.0.0.1:${port2}/list-peers`, { method: "POST", body: JSON.stringify({ scope: "machine", cwd: "x", git_root: null }) })).json();
  assert.deepEqual(peers.map((p) => p.id), [reg.id]);
  await b2.close();
});

test("GET /health reports ok and a peer count", async (t) => {
  const { port } = await startBroker(t);
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(typeof body.peers, "number");
});

test("POST /shutdown closes the broker gracefully", async (t) => {
  let shutdownCalled = false;
  const { port, call } = await startBroker(t, { onShutdown: () => { shutdownCalled = true; } });
  const { body } = await call("/shutdown", {});
  assert.equal(body.ok, true);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(shutdownCalled, true, "onShutdown hook must fire");
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }));
});

test("unknown POST path is a 404", async (t) => {
  const { call } = await startBroker(t);
  const notFound = await call("/no-such", {});
  assert.equal(notFound.status, 404);
});