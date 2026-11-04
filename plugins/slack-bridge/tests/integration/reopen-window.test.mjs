// Integration: when text lands mid-turn the reply posts, and a live block goes back
// under it with its clock, so the channel always ends in what the session is doing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { closePeerWindows } from "../../src/core/live-route.mjs";
import { setup, slack, makePayload, waitFor, delay, hasUpdate, idxOf, placeholderTss } from "./route-harness.mjs";

const QUIET = 60;
const claimed = (t, opts = {}) => setup(t, { claims: [["peerA", "C1"]], quietGapMs: QUIET, ...opts });

// Slack ids are deduped across the process, so each send needs its own.
let nextId = 0;
const send = (s, text) => slack(s, makePayload({ channel: "C1", text, client_msg_id: `reopen-${++nextId}` }));
const msg = (id, kind, text = "") => ({ id, from_id: "peerA", kind, text });
const text = (id, body) => ({ id, from_id: "peerA", text: body });
const deliver = (s, ...messages) => s.broker.deliverAll("slack-bridge", messages);
const lastStatus = (s) => s.hb.instances.at(-1).statuses.at(-1);
const settled = (s, needle) => waitFor(() => hasUpdate(s.web, needle)).then(() => delay(20));
const unreadMessage = async (s) => {
  await send(s, "go");
  await waitFor(() => s.broker.sendCalls.length === 1);
};
const readMessage = async (s) => {
  await unreadMessage(s);
  deliver(s, msg("r0", "read"));
  await waitFor(() => s.broker.acked.includes("r0"));
};

// Holds the reply's post open, so a test can land something during finalise.
function holdReplyPost(s) {
  const real = s.web.chatUpdate;
  let release;
  const gate = new Promise((r) => { release = r; });
  const held = { entered: false, release };
  s.web.chatUpdate = async (p) => { held.entered = true; await gate; return real(p); };
  return held;
}

test("a status on a block holding text reopens one block under the reply", async (t) => {
  const s = claimed(t);
  await readMessage(s);
  deliver(s, text("t1", "before the tool"), msg("s1", "status", "Bash: npm test"));
  await waitFor(() => s.hb.instances.length === 2);

  const [first, second] = s.hb.instances;
  assert.equal(second.startedAt, first.startedAt, "the clock carries on");
  assert.equal(second.statuses.at(-1), "Bash: npm test");
  const replied = idxOf(s.web, ([ty, p]) => ty === "update" && p.text?.includes("before the tool"));
  const reopened = idxOf(s.web, ([ty, p]) => ty === "post" && p._ts === placeholderTss(s.web)[1]);
  assert.ok(replied >= 0 && replied < reopened, "the block sits under the reply");

  deliver(s, msg("e1", "turn-end"));
  await waitFor(() => s.web.calls.some(([ty, p]) => ty === "delete" && p.ts === second.ts));
});

test("every reply of a turn hands the block and its clock on", async (t) => {
  const s = claimed(t);
  await readMessage(s);
  deliver(s, text("t1", "one"), msg("s1", "status", "Read: a.md"));
  await waitFor(() => s.hb.instances.length === 2);
  deliver(s, text("t2", "two"), msg("s2", "status", "Read: b.md"));
  await waitFor(() => s.hb.instances.length === 3);

  assert.equal(new Set(s.hb.instances.map((i) => i.startedAt)).size, 1);
  assert.equal(lastStatus(s), "Read: b.md");
});

test("a final reply reopens nothing", async (t) => {
  const s = claimed(t);
  await readMessage(s);
  deliver(s, text("t1", "the answer"));
  await settled(s, "the answer");
  assert.equal(s.hb.instances.length, 1);
});

test("text landing while a message is unread reopens a block for its answer", async (t) => {
  const s = claimed(t);
  await unreadMessage(s);
  deliver(s, text("t1", "older answer"));
  await waitFor(() => s.hb.instances.length === 2);

  deliver(s, msg("e1", "turn-end"));
  await waitFor(() => s.broker.acked.includes("e1"));
  await delay(20);
  assert.equal(s.hb.instances[1].stopped, false, "the session has yet to take the message, so the block stays");

  // Once read, the turn answering it ends the block.
  deliver(s, msg("r1", "read"));
  await waitFor(() => s.broker.acked.includes("r1"));
  deliver(s, msg("e2", "turn-end"));
  await waitFor(() => s.hb.instances[1].stopped);
});

test("an API error ends a reopened block, though its message is unread", async (t) => {
  const s = claimed(t);
  await unreadMessage(s);
  deliver(s, text("t1", "older answer"));
  await waitFor(() => s.hb.instances.length === 2);

  deliver(s, msg("e1", "turn-end", "stop failure"));
  await waitFor(() => s.web.calls.some(([ty, p]) => ty === "delete" && p.ts === s.hb.instances[1].ts));
  assert.ok(s.hb.instances.every((i) => i.stopped), "nothing will take the message, so nothing ticks");
});

test("a reply in its quiet gap at an API error reopens nothing, though its message is unread", async (t) => {
  const s = claimed(t);
  await unreadMessage(s);
  deliver(s, text("t1", "older answer"), msg("e1", "turn-end", "stop failure"));
  await settled(s, "older answer");
  assert.equal(s.hb.instances.length, 1);
});

test("a read on a block holding text reopens it: the session is on the message", async (t) => {
  const s = claimed(t);
  await unreadMessage(s);
  deliver(s, text("t1", "older answer"));
  deliver(s, msg("e1", "turn-end"));
  await waitFor(() => s.broker.acked.includes("e1"));
  deliver(s, msg("r1", "read"));
  await waitFor(() => s.broker.acked.includes("r1"));
  await waitFor(() => s.hb.instances.length === 2);

  const second = s.hb.instances[1];
  deliver(s, msg("e2", "turn-end"));
  await waitFor(() => s.web.calls.some(([ty, p]) => ty === "delete" && p.ts === second.ts));
});

test("a turn-end in the quiet gap reopens nothing", async (t) => {
  const s = claimed(t);
  await readMessage(s);
  deliver(s, text("t1", "the answer"), msg("s1", "status", "Bash: npm test"));
  deliver(s, msg("e1", "turn-end"));
  await settled(s, "the answer");
  assert.equal(s.hb.instances.length, 1);
});

test("a status after the turn-end on a block still holding text reopens nothing", async (t) => {
  const s = claimed(t);
  await readMessage(s);
  deliver(s, text("t1", "the answer"));
  // The status's async hook started in the finished turn, before its Stop hook.
  const stopStartedAt = Date.now();
  deliver(s, { ...msg("e1", "turn-end"), hook_started_at: stopStartedAt });
  await waitFor(() => s.broker.acked.includes("e1"));
  deliver(s, { ...msg("s1", "status", "Bash: npm test"), hook_started_at: stopStartedAt - 1 });
  await waitFor(() => s.broker.acked.includes("s1"));
  await settled(s, "the answer");
  assert.equal(s.hb.instances.length, 1);
});

test("a turn-end during the reply's post reopens nothing", async (t) => {
  const s = claimed(t);
  await readMessage(s);
  const held = holdReplyPost(s);
  deliver(s, text("t1", "the answer"), msg("s1", "status", "Bash: npm test"));
  await waitFor(() => held.entered);
  deliver(s, msg("e1", "turn-end"));
  await waitFor(() => s.broker.acked.includes("e1"));
  held.release();
  await settled(s, "the answer");
  assert.equal(s.hb.instances.length, 1);
});

test("an unread message reopens through a turn-end during the reply's post", async (t) => {
  const s = claimed(t);
  await unreadMessage(s);
  const held = holdReplyPost(s);
  deliver(s, text("t1", "older answer"));
  await waitFor(() => held.entered);
  deliver(s, msg("e1", "turn-end"));
  await waitFor(() => s.broker.acked.includes("e1"));
  held.release();
  await waitFor(() => s.hb.instances.length === 2);
  assert.equal(s.hb.instances[1].stopped, false, "the session has yet to take the message");
});

test("a disconnect during the reply's post reopens nothing", async (t) => {
  const s = claimed(t);
  await readMessage(s);
  const held = holdReplyPost(s);
  deliver(s, text("t1", "the answer"), msg("s1", "status", "Bash: npm test"));
  await waitFor(() => held.entered);
  await closePeerWindows("peerA");
  held.release();
  await settled(s, "the answer");
  assert.equal(s.hb.instances.length, 1);
});

test("a block already at the bottom stands in for the reopen", async (t) => {
  const s = claimed(t, { quietGapMs: 150 });
  await readMessage(s);
  deliver(s, text("t1", "the answer"), msg("s1", "status", "Bash: npm test"));
  await delay(10);
  await send(s, "next");
  await waitFor(() => s.broker.sendCalls.length === 2);
  await settled(s, "the answer");
  assert.equal(s.hb.instances.length, 2);
});

test("a reply that failed to post reopens nothing", async (t) => {
  const s = claimed(t);
  await readMessage(s);
  s.web.chatUpdate = async () => { throw new Error("slack down"); };
  deliver(s, text("t1", "the answer"), msg("s1", "status", "Bash: npm test"));
  await waitFor(() => s.log.entries.some(([, m]) => m === "failed to post live-session reply"));
  await delay(20);
  assert.equal(s.hb.instances.length, 1);
});

test("a status just after a mid-turn reply opens a block: only a turn-end makes it late", async (t) => {
  const s = claimed(t);
  await readMessage(s);
  deliver(s, text("t1", "the answer"));
  await settled(s, "the answer");

  deliver(s, msg("s1", "status", "Bash: npm test"));
  await waitFor(() => s.hb.instances.length === 2);
  assert.equal(lastStatus(s), "Bash: npm test");
});
