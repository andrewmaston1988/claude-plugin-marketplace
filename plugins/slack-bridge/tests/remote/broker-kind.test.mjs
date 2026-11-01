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
