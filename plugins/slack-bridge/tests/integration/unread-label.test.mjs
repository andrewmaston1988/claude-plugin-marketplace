// Integration: the live block says `Not read yet` from the moment a Slack message
// is routed until the broker reports the session took it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { closePeerWindows } from "../../src/core/live-route.mjs";
import { setup, slack, makePayload, waitFor, delay } from "./route-harness.mjs";

// Slack ids are deduped across the process, so each send needs its own.
let nextId = 0;
const send = (s, text) => slack(s, makePayload({ channel: "C1", text, client_msg_id: `unread-${++nextId}` }));
const read = (s, id, from = "peerA") => s.broker.deliver("slack-bridge", { id, from_id: from, kind: "read", text: "" });
const status = (s, id, text) => s.broker.deliver("slack-bridge", { id, from_id: "peerA", kind: "status", text });
const lastStatus = (s, n = -1) => s.hb.instances.at(n).statuses.at(-1);

test("a routed message reads Not read yet until the session takes it", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  await send(s, "hello");
  await waitFor(() => s.broker.sendCalls.length === 1);
  assert.equal(lastStatus(s), "Not read yet");

  read(s, "r1");
  await waitFor(() => s.broker.acked.includes("r1"));
  assert.equal(lastStatus(s), "", "the label clears, leaving the plain block");
});

test("a tool status sits behind the label, and survives the read", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  await send(s, "hello");
  await waitFor(() => s.broker.sendCalls.length === 1);

  status(s, "s1", "Bash: npm test");
  await waitFor(() => s.broker.acked.includes("s1"));
  assert.equal(lastStatus(s), "Not read yet · Bash: npm test");

  read(s, "r1");
  await waitFor(() => s.broker.acked.includes("r1"));
  assert.equal(lastStatus(s), "Bash: npm test");
});

test("two messages take two reads to clear", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]], replyTimeoutMs: 60_000 });
  await send(s, "first");
  await send(s, "second");
  await waitFor(() => s.broker.sendCalls.length === 2);

  read(s, "r1");
  await waitFor(() => s.broker.acked.includes("r1"));
  assert.equal(lastStatus(s), "Not read yet", "one message is still unread");

  read(s, "r2");
  await waitFor(() => s.broker.acked.includes("r2"));
  assert.equal(lastStatus(s), "");
});

test("the block taking over from an older one keeps its tool status", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]], replyTimeoutMs: 60_000 });
  await send(s, "first");
  await waitFor(() => s.broker.sendCalls.length === 1);
  status(s, "s1", "Bash: npm test");
  await waitFor(() => s.broker.acked.includes("s1"));

  await send(s, "second");
  await waitFor(() => s.broker.sendCalls.length === 2);
  assert.equal(s.hb.instances.length, 2);
  assert.equal(lastStatus(s), "Not read yet · Bash: npm test");
});

test("a read is acked with no claim, so it never retries on the lease", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  read(s, "r1", "ghost");
  await waitFor(() => s.broker.acked.includes("r1"));
});

test("a read with nothing unread does not eat the next message's label", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  read(s, "r1");
  await waitFor(() => s.broker.acked.includes("r1"));

  await send(s, "hello");
  await waitFor(() => s.broker.sendCalls.length === 1);
  assert.equal(lastStatus(s), "Not read yet");
});

test("a failed send takes its unread count back", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  const realSend = s.broker.sendMessage;
  s.broker.sendMessage = async () => { throw new Error("broker refused"); };
  await send(s, "lost");
  await waitFor(() => s.hb.instances[0].stopped);

  s.broker.sendMessage = realSend;
  await send(s, "hello");
  await waitFor(() => s.broker.sendCalls.length === 1);
  read(s, "r1");
  await waitFor(() => s.broker.acked.includes("r1"));
  assert.equal(lastStatus(s), "", "one read clears the one message that was sent");
});

test("a disconnect forgets the unread count", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  await send(s, "hello");
  await waitFor(() => s.broker.sendCalls.length === 1);
  await closePeerWindows("peerA");

  await send(s, "again");
  await waitFor(() => s.broker.sendCalls.length === 2);
  read(s, "r1");
  await waitFor(() => s.broker.acked.includes("r1"));
  assert.equal(lastStatus(s), "", "the message before the disconnect left no count behind");
});

test("a turn-end keeps the unread count", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  await send(s, "first");
  await send(s, "second");
  await waitFor(() => s.broker.sendCalls.length === 2);
  s.broker.deliver("slack-bridge", { id: "e1", from_id: "peerA", kind: "turn-end", text: "" });
  await waitFor(() => s.broker.acked.includes("e1"));
  await delay(20);

  read(s, "r1");
  await waitFor(() => s.broker.acked.includes("r1"));
  assert.equal(lastStatus(s), "Not read yet", "both messages are still queued for the session");
});
