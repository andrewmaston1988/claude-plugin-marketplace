// A status or prompt belongs to the turn its hook started in. Async hooks outlast
// their turn, so the daemon drops one whose hook started before the turn-end, and
// shows one whose hook started after it, however soon after it lands. A turn-end
// that starts no waiter ends only the blocks of messages queued before its hook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, slack, makePayload, waitFor, delay, placeholderTss } from "./route-harness.mjs";
import { _closedMarks } from "../../src/core/handler.mjs";

const ticking = (s) => s.hb.instances.filter((i) => !i.stopped);

test("a status whose hook started after the Stop hook opens a block, however soon it lands", async (t) => {
  const s = setup(t, { claims: [["peerS1", "C-S1"]] });
  // The Stop hook waits on the transcript before its turn-end goes, and the next
  // turn's first tool can start in that gap.
  const stopStartedAt = Date.now() - 1000;
  s.broker.deliver("slack-bridge", { from_id: "peerS1", kind: "turn-end", hook_started_at: stopStartedAt });
  await waitFor(() => _closedMarks().has("peerS1"), 3000);
  s.broker.deliver("slack-bridge", { from_id: "peerS1", kind: "status", text: "Bash: ./deploy.sh", hook_started_at: stopStartedAt + 500 });
  await waitFor(() => ticking(s).length === 1, 3000);
  assert.deepEqual(ticking(s)[0].statuses, ["Bash: ./deploy.sh"]);
});

test("a prompt whose turn ends while it posts opens no block", async (t) => {
  // The prompt's post is the first Slack call; hold it as a 429's Retry-After would.
  const s = setup(t, { claims: [["peerP1", "C-P1"]], latencyMs: (k) => (k === 0 ? 300 : 0) });
  const startedAt = Date.now();
  s.broker.deliver("slack-bridge", { from_id: "peerP1", kind: "prompt", text: "thanks", hook_started_at: startedAt });
  await delay(50);
  s.broker.deliver("slack-bridge", { from_id: "peerP1", kind: "turn-end", hook_started_at: startedAt + 10 });
  await waitFor(() => s.web.calls.some(([ty]) => ty === "post"), 3000);
  await delay(300);
  assert.deepEqual([placeholderTss(s.web), ticking(s)], [[], []], "no block for a turn that has ended");
});

test("a Slack message routed while a status's block is posting gets its own block, which the turn-end leaves", async (t) => {
  // The status's placeholder post lands after the message's.
  const s = setup(t, { claims: [["peerR1", "C-R1"]], latencyMs: (k) => (k === 0 ? 300 : 50) });
  s.broker.deliver("slack-bridge", { from_id: "peerR1", kind: "status", text: "Bash: npm test", hook_started_at: Date.now() });
  await delay(20);
  await slack(s, makePayload({ channel: "C-R1", text: "msg", client_msg_id: "m-r1" }));
  await waitFor(() => s.broker.sendCalls.length === 1, 3000);
  await delay(500);
  assert.equal(ticking(s).length, 1, "one block, under the message");
  s.broker.deliver("slack-bridge", { from_id: "peerR1", kind: "turn-end", hook_started_at: Date.now() });
  await waitFor(() => _closedMarks().has("peerR1"), 3000);
  await delay(200);
  assert.equal(ticking(s).length, 1, "the message is unread, so its block stays");
});

test("a turn-end with a reason stops a queued message's block and says it stays queued", async (t) => {
  const s = setup(t, { claims: [["peerQ1", "C-Q1"]] });
  await slack(s, makePayload({ channel: "C-Q1", text: "msg", client_msg_id: "m-q1" }));
  await waitFor(() => s.broker.sendCalls.length === 1, 3000);
  await delay(5);
  s.broker.deliver("slack-bridge", { from_id: "peerQ1", kind: "turn-end", text: "The session stopped on an API error.", hook_started_at: Date.now() });
  await waitFor(() => ticking(s).length === 0, 3000);
  const notice = s.web.calls.filter(([ty]) => ty === "update").map(([, p]) => p.text);
  assert.deepEqual(notice, ["The session stopped on an API error. Your message stays queued."]);
});

test("a message queued after that hook started keeps its block: a waiter may still take it", async (t) => {
  const s = setup(t, { claims: [["peerQ2", "C-Q2"]] });
  const hookStartedAt = Date.now() - 1;
  await slack(s, makePayload({ channel: "C-Q2", text: "msg", client_msg_id: "m-q2" }));
  await waitFor(() => s.broker.sendCalls.length === 1, 3000);
  s.broker.deliver("slack-bridge", { from_id: "peerQ2", kind: "turn-end", text: "The session is idle and not listening.", hook_started_at: hookStartedAt });
  await waitFor(() => _closedMarks().has("peerQ2"), 3000);
  await delay(100);
  assert.equal(ticking(s).length, 1);
});
