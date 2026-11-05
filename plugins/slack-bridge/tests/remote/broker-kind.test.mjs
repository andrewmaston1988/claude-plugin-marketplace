// The message kind is the one field the daemon dispatches on. The broker only
// carries it — the same wire format claude-peers uses, plus the kinds the
// terminal mirror added. A kind the broker does not know is downgraded to
// "text", which would post a prompt as if it were the session's reply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startBroker, REG } from "./broker-harness.mjs";

test("a sent message carries kind; only kind 'status' is treated as a status", async (t) => {
  const { call } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "plain" });
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "Read: a.mjs", kind: "status" });
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "mislabelled", kind: "banana" });
  const { body: taken } = await call("/take-messages", { id: b.id });
  assert.deepEqual(taken.messages.map((m) => m.kind), ["text", "status", "text"]);
});

test("kind survives a round-trip through /wait", async (t) => {
  const { call } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "Bash: ls", kind: "status" });
  const { body: waited } = await call("/wait", { id: b.id, timeout_ms: 1000 });
  assert.equal(waited.messages[0].kind, "status");
});

test("kind question survives the broker, so a pending AskUserQuestion reaches the daemon as one", async (t) => {
  const { call } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "Which?", kind: "question" });
  const { body: waited } = await call("/wait", { id: b.id, timeout_ms: 1000 });
  assert.equal(waited.messages[0].kind, "question");
});

test("kind prompt and turn-end survive the broker unchanged", async (t) => {
  const { call } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "typed here", kind: "prompt" });
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "", kind: "turn-end" });
  const { body: waited } = await call("/wait", { id: b.id, timeout_ms: 1000 });
  assert.deepEqual(waited.messages.map((m) => m.kind), ["prompt", "turn-end"]);
});

// A delivered operator message is what keeps its block past a Stop. The
// ack is the one place all three consumers meet: waiter, check_messages, inbox hook.
const deliver = async (call, peerId, texts) => {
  for (const text of texts) await call("/send-message", { from_id: "slack-bridge", to_id: peerId, text });
  const { body } = await call("/take-messages", { id: peerId, lease: true });
  return body.messages.map((m) => m.id);
};

test("acking daemon messages queues one read row each back to the daemon", async (t) => {
  const { call } = await startBroker(t);
  const { body: peer } = await call("/register", { ...REG, pid: process.pid });
  const ids = await deliver(call, peer.id, ["one", "two"]);
  await call("/ack", { id: peer.id, ids });
  const { body: receipts } = await call("/take-messages", { id: "slack-bridge" });
  assert.deepEqual(receipts.messages.map((m) => [m.from_id, m.kind, m.text]),
    [[peer.id, "read", ""], [peer.id, "read", ""]]);
});

// The daemon drops a status whose hook started before the turn-end, by this stamp.
test("a message carries its hook's start time through the broker, and only a number", async (t) => {
  const { call } = await startBroker(t);
  const { body: peer } = await call("/register", { ...REG, pid: process.pid });
  await call("/send-message", { from_id: peer.id, to_id: "slack-bridge", text: "Bash: ls", kind: "status", hook_started_at: 1234 });
  await call("/send-message", { from_id: peer.id, to_id: "slack-bridge", text: "", kind: "turn-end", hook_started_at: "soon" });
  const { body: waited } = await call("/wait", { id: "slack-bridge", timeout_ms: 1000 });
  assert.deepEqual(waited.messages.map((m) => m.hook_started_at), [1234, undefined]);
});

test("a repeated ack queues nothing more", async (t) => {
  const { call } = await startBroker(t);
  const { body: peer } = await call("/register", { ...REG, pid: process.pid });
  const ids = await deliver(call, peer.id, ["one"]);
  await call("/ack", { id: peer.id, ids });
  await call("/ack", { id: peer.id, ids });
  const { body: receipts } = await call("/take-messages", { id: "slack-bridge" });
  assert.equal(receipts.messages.length, 1);
});

test("acking a message from another peer queues no read row", async (t) => {
  const { call } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "peer to peer" });
  const { body: taken } = await call("/take-messages", { id: b.id, lease: true });
  await call("/ack", { id: b.id, ids: taken.messages.map((m) => m.id) });
  const { body: forA } = await call("/take-messages", { id: a.id });
  const { body: forDaemon } = await call("/take-messages", { id: "slack-bridge" });
  assert.deepEqual([forA.messages, forDaemon.messages], [[], []]);
});

test("the daemon acking a session reply does not bounce a read row back", async (t) => {
  const { call } = await startBroker(t);
  const { body: peer } = await call("/register", { ...REG, pid: process.pid });
  await call("/send-message", { from_id: peer.id, to_id: "slack-bridge", text: "reply" });
  const { body: taken } = await call("/take-messages", { id: "slack-bridge", lease: true });
  await call("/ack", { id: "slack-bridge", ids: taken.messages.map((m) => m.id) });
  const { body: forPeer } = await call("/take-messages", { id: peer.id });
  assert.deepEqual(forPeer.messages, []);
});

test("a read row wakes a daemon already waiting", async (t) => {
  const { call } = await startBroker(t);
  const { body: peer } = await call("/register", { ...REG, pid: process.pid });
  const ids = await deliver(call, peer.id, ["one"]);
  const waiting = call("/wait", { id: "slack-bridge", timeout_ms: 2000, lease: true });
  await new Promise((r) => setTimeout(r, 50));
  await call("/ack", { id: peer.id, ids });
  const { body: woken } = await waiting;
  assert.deepEqual(woken.messages.map((m) => m.kind), ["read"]);
});
