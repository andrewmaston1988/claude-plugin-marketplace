// What the read receipt owes the rest of the daemon: the ceiling never calls a read
// message queued, every block hears the read, and a stray from an unclaimed peer is
// acked once instead of coming back on every lease.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, slack, makePayload, waitFor, delay, hasUpdate, placeholderTss } from "./route-harness.mjs";

let nextId = 0;
const send = (s, text) => slack(s, makePayload({ channel: "C1", text, client_msg_id: `ceiling-${++nextId}` }));
const deliver = (s, id, kind, text = "", from = "peerA") => s.broker.deliver("slack-bridge", { id, from_id: from, kind, text });
const deleted = (s, ts) => s.web.calls.some(([ty, p]) => ty === "delete" && p.ts === ts);

test("at the ceiling a read message's block goes quietly, never saying it is queued", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]], replyTimeoutMs: 10 });
  await send(s, "long job");
  await waitFor(() => s.broker.sendCalls.length === 1);
  deliver(s, "r1", "read");
  await waitFor(() => s.broker.acked.includes("r1"));
  const [ts] = placeholderTss(s.web);
  await waitFor(() => deleted(s, ts));
  assert.ok(!hasUpdate(s.web, "stays queued"), "the session has the message");
  assert.ok(s.hb.instances.every((i) => i.stopped));
});

test("at the ceiling an unread message's block still says it is queued", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]], replyTimeoutMs: 10 });
  await send(s, "anyone there");
  await waitFor(() => hasUpdate(s.web, "stays queued"));
});

test("a read clears the label on the newest block, not only the one holding a reply", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]], replyTimeoutMs: 60_000, quietGapMs: 2_000 });
  await send(s, "first");
  await waitFor(() => s.broker.sendCalls.length === 1);
  deliver(s, "x1", "text", "An answer in its quiet gap");
  await delay(100); // a reply is acked only once it posts, after the gap
  await send(s, "second");
  await waitFor(() => s.broker.sendCalls.length === 2 && s.hb.instances.length === 2);

  deliver(s, "r1", "read");
  deliver(s, "r2", "read");
  await waitFor(() => s.broker.acked.includes("r2"));
  await delay(20);
  assert.equal(s.hb.instances.at(-1).statuses.at(-1), "", "both messages are read");
});

test("a status from a peer with no claim is acked once, not re-leased", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  deliver(s, "s1", "status", "Bash: npm test", "ghost");
  await waitFor(() => s.broker.acked.includes("s1"));
  const warns = s.log.entries.filter((e) => e[0] === "warn" && e[1] === "reply dropped: no claim for peer");
  assert.equal(warns.length, 1);
});
