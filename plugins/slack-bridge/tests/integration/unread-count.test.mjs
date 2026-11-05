// Integration: a routed Slack message counts as unread until the broker reports the
// session took it. The count keeps a block past a Stop; the block never shows it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { closePeerWindows } from "../../src/core/live-route.mjs";
import { hasUnread } from "../../src/core/route-status.mjs";
import { setup, slack, makePayload, waitFor, delay } from "./route-harness.mjs";

// Slack ids are deduped across the process, so each send needs its own.
let nextId = 0;
const send = (s, text) => slack(s, makePayload({ channel: "C1", text, client_msg_id: `unread-${++nextId}` }));
const read = (s, id, from = "peerA") => s.broker.deliver("slack-bridge", { id, from_id: from, kind: "read", text: "" });
const status = (s, id, text) => s.broker.deliver("slack-bridge", { id, from_id: "peerA", kind: "status", text });
const turnEnd = (s, id, text = "") => s.broker.deliver("slack-bridge", { id, from_id: "peerA", kind: "turn-end", text });
const lastStatus = (s, n = -1) => s.hb.instances.at(n).statuses.at(-1);

test("a routed message counts as unread until the session takes it", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  await send(s, "hello");
  await waitFor(() => s.broker.sendCalls.length === 1);
  assert.equal(hasUnread("peerA"), true);
  assert.equal(lastStatus(s), undefined, "the block shows only its clock");

  read(s, "r1");
  await waitFor(() => s.broker.acked.includes("r1"));
  assert.equal(hasUnread("peerA"), false);
});

test("a message whose block never posted is not counted unread", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  const post = s.web.chatPostMessage;
  s.web.chatPostMessage = async () => { throw new Error("slack down"); };
  await send(s, "hello");
  await waitFor(() => s.log.entries.some(([, msg]) => msg === "failed to post routed placeholder"));
  s.web.chatPostMessage = post;
  await waitFor(() => !hasUnread("peerA"));
});

test("a tool status survives the read", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  await send(s, "hello");
  await waitFor(() => s.broker.sendCalls.length === 1);

  status(s, "s1", "Bash: npm test");
  await waitFor(() => s.broker.acked.includes("s1"));
  read(s, "r1");
  await waitFor(() => s.broker.acked.includes("r1"));
  assert.deepEqual(s.hb.instances[0].statuses, ["Bash: npm test"]);
});

test("two messages take two reads to clear", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  await send(s, "first");
  await send(s, "second");
  await waitFor(() => s.broker.sendCalls.length === 2);

  read(s, "r1");
  await waitFor(() => s.broker.acked.includes("r1"));
  assert.equal(hasUnread("peerA"), true, "one message is still unread");

  read(s, "r2");
  await waitFor(() => s.broker.acked.includes("r2"));
  assert.equal(hasUnread("peerA"), false);
});

test("the block taking over from an older one keeps its tool status", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  await send(s, "first");
  await waitFor(() => s.broker.sendCalls.length === 1);
  status(s, "s1", "Bash: npm test");
  await waitFor(() => s.broker.acked.includes("s1"));

  await send(s, "second");
  await waitFor(() => s.broker.sendCalls.length === 2);
  assert.equal(s.hb.instances.length, 2);
  assert.equal(lastStatus(s), "Bash: npm test");
});

test("a read is acked with no claim, so it never retries on the lease", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  read(s, "r1", "ghost");
  await waitFor(() => s.broker.acked.includes("r1"));
});

test("a status from a peer with no claim is acked once, not re-leased", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  s.broker.deliver("slack-bridge", { id: "s1", from_id: "ghost", kind: "status", text: "Bash: npm test" });
  await waitFor(() => s.broker.acked.includes("s1"));
  const warns = s.log.entries.filter((e) => e[0] === "warn" && e[1] === "reply dropped: no claim for peer");
  assert.equal(warns.length, 1);
});

test("a read with nothing unread does not eat the next message's count", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  read(s, "r1");
  await waitFor(() => s.broker.acked.includes("r1"));

  await send(s, "hello");
  await waitFor(() => s.broker.sendCalls.length === 1);
  assert.equal(hasUnread("peerA"), true);
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
  assert.equal(hasUnread("peerA"), false, "one read clears the one message that was sent");
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
  assert.equal(hasUnread("peerA"), false, "the message before the disconnect left no count behind");
});

test("a turn-end keeps the unread count", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  await send(s, "first");
  await send(s, "second");
  await waitFor(() => s.broker.sendCalls.length === 2);
  turnEnd(s, "e1");
  await waitFor(() => s.broker.acked.includes("e1"));
  await delay(20);

  read(s, "r1");
  await waitFor(() => s.broker.acked.includes("r1"));
  assert.equal(hasUnread("peerA"), true, "the session has yet to take both");
});

test("an API error ends every block but keeps the count for the read still to come", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  await send(s, "first");
  await send(s, "second");
  await waitFor(() => s.broker.sendCalls.length === 2);
  turnEnd(s, "e1", "stop failure");
  await waitFor(() => s.broker.acked.includes("e1"));
  await waitFor(() => s.hb.instances.every((i) => i.stopped));

  read(s, "r1");
  await waitFor(() => s.broker.acked.includes("r1"));
  assert.equal(hasUnread("peerA"), true, "the next take still owes one read");
});
