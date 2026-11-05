// A status or prompt belongs to the turn its hook started in. Async hooks outlast
// their turn, so the daemon drops one whose hook started before the turn-end, and
// shows one whose hook started after it, however soon after it lands. A turn-end
// that starts no waiter ends every block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, slack, makePayload, waitFor, delay, idxOf, placeholderTss } from "./route-harness.mjs";
import { _closedMarks } from "../../src/core/handler.mjs";
import { hasUnread } from "../../src/core/route-status.mjs";

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

test("an API error ends a queued message's block, and says nothing", async (t) => {
  const s = setup(t, { claims: [["peerQ1", "C-Q1"]] });
  await slack(s, makePayload({ channel: "C-Q1", text: "msg", client_msg_id: "m-q1" }));
  await waitFor(() => s.broker.sendCalls.length === 1, 3000);
  s.broker.deliver("slack-bridge", { from_id: "peerQ1", kind: "turn-end", text: "stop failure", hook_started_at: Date.now() });
  await waitFor(() => ticking(s).length === 0, 3000);
  assert.ok(s.web.calls.some(([ty, p]) => ty === "delete" && p.ts === placeholderTss(s.web)[0]));
  assert.deepEqual(s.web.calls.filter(([ty]) => ty === "update"), [], "no notice");
});

test("a typed prompt after an interrupted turn ends that turn's block and opens one under itself", async (t) => {
  const s = setup(t, { claims: [["peerT1", "C-T1"]] });
  // Esc runs no hook, so the interrupted turn's block is still up.
  s.broker.deliver("slack-bridge", { from_id: "peerT1", kind: "status", text: "Bash: npm test", hook_started_at: Date.now() });
  await waitFor(() => ticking(s).length === 1, 3000);
  const [old] = placeholderTss(s.web);
  s.broker.deliver("slack-bridge", { from_id: "peerT1", kind: "prompt", text: "try again", hook_started_at: Date.now() });
  await waitFor(() => placeholderTss(s.web).length === 2 && ticking(s).length === 1, 3000);
  assert.ok(s.web.calls.some(([ty, p]) => ty === "delete" && p.ts === old), "the interrupted turn's block goes");
  const prompt = idxOf(s.web, ([ty, p]) => ty === "post" && p.text?.includes("try again"));
  const block = idxOf(s.web, ([ty, p]) => ty === "post" && p._ts === placeholderTss(s.web)[1]);
  assert.ok(prompt >= 0 && prompt < block, "the new block sits under the prompt");
});

test("a typed prompt after an interrupted Slack turn ends its block once the message is read", async (t) => {
  const s = setup(t, { claims: [["peerT2", "C-T2"]] });
  await slack(s, makePayload({ channel: "C-T2", text: "go", client_msg_id: "m-t2" }));
  await waitFor(() => s.broker.sendCalls.length === 1, 3000);
  s.broker.deliver("slack-bridge", { id: "r1", from_id: "peerT2", kind: "read", text: "" });
  await waitFor(() => s.broker.acked.includes("r1"), 3000);
  s.broker.deliver("slack-bridge", { id: "s1", from_id: "peerT2", kind: "status", text: "Bash: npm test", hook_started_at: Date.now() });
  await waitFor(() => s.broker.acked.includes("s1"), 3000);
  const [old] = placeholderTss(s.web);
  s.broker.deliver("slack-bridge", { id: "p1", from_id: "peerT2", kind: "prompt", text: "try again", hook_started_at: Date.now() });
  await waitFor(() => placeholderTss(s.web).length === 2 && ticking(s).length === 1, 3000);
  assert.ok(s.web.calls.some(([ty, p]) => ty === "delete" && p.ts === old), "the interrupted turn's block goes");
  const prompt = idxOf(s.web, ([ty, p]) => ty === "post" && p.text?.includes("try again"));
  const block = idxOf(s.web, ([ty, p]) => ty === "post" && p._ts === placeholderTss(s.web)[1]);
  assert.ok(prompt >= 0 && prompt < block, "the new block sits under the prompt");
});

test("a typed prompt moves an unread message's block under itself", async (t) => {
  const s = setup(t, { claims: [["peerT3", "C-T3"]], quietGapMs: 50 });
  await slack(s, makePayload({ channel: "C-T3", text: "go", client_msg_id: "m-t3" }));
  await waitFor(() => s.broker.sendCalls.length === 1, 3000);
  const [old] = placeholderTss(s.web);
  s.broker.deliver("slack-bridge", { id: "p1", from_id: "peerT3", kind: "prompt", text: "meanwhile", hook_started_at: Date.now() });
  await waitFor(() => s.broker.acked.includes("p1"), 3000);
  const [, block] = placeholderTss(s.web);
  const prompt = idxOf(s.web, ([ty, p]) => ty === "post" && p.text?.includes("meanwhile"));
  assert.ok(block && prompt < idxOf(s.web, ([ty, p]) => ty === "post" && p._ts === block), "the block sits under the prompt");
  assert.ok(s.web.calls.some(([ty, p]) => ty === "delete" && p.ts === old), "one block, not two");
  assert.equal(hasUnread("peerT3"), true);
  // A Stop leaves it: its waiter takes the message.
  s.broker.deliver("slack-bridge", { id: "e1", from_id: "peerT3", kind: "turn-end", hook_started_at: Date.now() });
  await waitFor(() => s.broker.acked.includes("e1"), 3000);
  assert.equal(ticking(s).length, 1, "the unread message keeps the block");
  s.broker.deliver("slack-bridge", { id: "x1", from_id: "peerT3", text: "the answer" });
  await waitFor(() => s.web.calls.some(([ty, p]) => ty === "update" && p.text?.includes("the answer")), 3000);
  assert.equal(s.web.calls.find(([ty, p]) => ty === "update" && p.text?.includes("the answer"))[1].ts, block, "the answer lands under the prompt");
});

test("a typed prompt after the interrupted turn's text opens its own block under the prompt", async (t) => {
  const s = setup(t, { claims: [["peerA1", "C-A1"]] });
  s.broker.deliver("slack-bridge", { id: "s1", from_id: "peerA1", kind: "status", text: "Bash: npm test", hook_started_at: Date.now() });
  await waitFor(() => ticking(s).length === 1, 3000);
  const [old] = placeholderTss(s.web);
  // The prompt hook mirrors the text written since the last hook, then sends the prompt.
  s.broker.deliver("slack-bridge", { id: "x1", from_id: "peerA1", text: "half an answer" });
  s.broker.deliver("slack-bridge", { id: "p1", from_id: "peerA1", kind: "prompt", text: "try again", hook_started_at: Date.now() });
  await waitFor(() => s.web.calls.some(([ty, p]) => ty === "update" && p.ts === old && p.text?.includes("half an answer")), 3000);
  await delay(50);
  const [, block] = placeholderTss(s.web);
  const prompt = idxOf(s.web, ([ty, p]) => ty === "post" && p.text?.includes("try again"));
  assert.ok(block && prompt < idxOf(s.web, ([ty, p]) => ty === "post" && p._ts === block), "the new turn's block sits under the prompt");
  assert.equal(ticking(s).length, 1, "the new turn's block ticks");
});

// The prompt's close waits on Slack, and a short turn can end in that wait.
test("a typed prompt whose turn ends while the old block clears opens nothing", async (t) => {
  // Calls: 0 the interrupted turn's block, 1 the prompt, 2 the old block's delete, held.
  const s = setup(t, { claims: [["peerD1", "C-D1"]], latencyMs: (k) => (k === 2 ? 300 : 0) });
  s.broker.deliver("slack-bridge", { id: "s1", from_id: "peerD1", kind: "status", text: "Bash: npm test", hook_started_at: Date.now() });
  await waitFor(() => ticking(s).length === 1, 3000);
  const promptStartedAt = Date.now();
  s.broker.deliver("slack-bridge", { id: "p1", from_id: "peerD1", kind: "prompt", text: "thanks", hook_started_at: promptStartedAt });
  await waitFor(() => s.web.calls.some(([ty, p]) => ty === "post" && p.text?.includes("thanks")), 3000);
  s.broker.deliver("slack-bridge", { id: "e1", from_id: "peerD1", kind: "turn-end", hook_started_at: promptStartedAt + 10 });
  await waitFor(() => s.broker.acked.includes("p1") && s.broker.acked.includes("e1"), 3000);
  await delay(100);
  assert.deepEqual([placeholderTss(s.web).length, ticking(s).length], [1, 0], "no block for a turn that has ended");
});

test("a typed prompt whose turn ends while the old block is still posting opens nothing", async (t) => {
  // Call 0, the interrupted turn's block, is still posting when the prompt closes it.
  const s = setup(t, { claims: [["peerD2", "C-D2"]], latencyMs: (k) => (k === 0 ? 300 : 0) });
  s.broker.deliver("slack-bridge", { id: "s1", from_id: "peerD2", kind: "status", text: "Bash: npm test", hook_started_at: Date.now() });
  await delay(50);
  const promptStartedAt = Date.now();
  s.broker.deliver("slack-bridge", { id: "p1", from_id: "peerD2", kind: "prompt", text: "thanks", hook_started_at: promptStartedAt });
  await waitFor(() => s.web.calls.some(([ty, p]) => ty === "post" && p.text?.includes("thanks")), 3000);
  s.broker.deliver("slack-bridge", { id: "e1", from_id: "peerD2", kind: "turn-end", hook_started_at: promptStartedAt + 10 });
  await waitFor(() => ["s1", "p1", "e1"].every((id) => s.broker.acked.includes(id)), 3000);
  await delay(100);
  assert.deepEqual([placeholderTss(s.web).length, ticking(s).length], [1, 0], "no block for a turn that has ended");
});

test("a turn-end with an older stamp leaves the newer mark", async (t) => {
  const s = setup(t, { claims: [["peerM1", "C-M1"]] });
  const later = Date.now();
  s.broker.deliver("slack-bridge", { id: "e1", from_id: "peerM1", kind: "turn-end", hook_started_at: later });
  await waitFor(() => s.broker.acked.includes("e1"), 3000);
  s.broker.deliver("slack-bridge", { id: "e0", from_id: "peerM1", kind: "turn-end", hook_started_at: later - 500 });
  await waitFor(() => s.broker.acked.includes("e0"), 3000);
  assert.equal(_closedMarks().get("peerM1"), later);
});

// One /wait batch is dispatched in parallel: the turn-end must end its turn before
// the status beside it asks whether it is late.
test("a finished turn's status beside its turn-end in one batch opens nothing", async (t) => {
  const s = setup(t, { claims: [["peerB1", "C-B1"]] });
  const stopStartedAt = Date.now();
  s.broker.deliverAll("slack-bridge", [
    { id: "e1", from_id: "peerB1", kind: "turn-end", hook_started_at: stopStartedAt },
    { id: "s1", from_id: "peerB1", kind: "status", text: "Bash: npm test", hook_started_at: stopStartedAt - 1 },
  ]);
  await waitFor(() => s.broker.acked.includes("e1") && s.broker.acked.includes("s1"), 3000);
  await delay(100);
  assert.deepEqual(placeholderTss(s.web), []);
});

test("the next turn's first status beside the turn-end in one batch keeps its block", async (t) => {
  const s = setup(t, { claims: [["peerB2", "C-B2"]] });
  s.broker.deliver("slack-bridge", { id: "s0", from_id: "peerB2", kind: "status", text: "Bash: npm test", hook_started_at: Date.now() });
  await waitFor(() => ticking(s).length === 1, 3000);
  const stopStartedAt = Date.now();
  s.broker.deliverAll("slack-bridge", [
    { id: "e1", from_id: "peerB2", kind: "turn-end", hook_started_at: stopStartedAt },
    { id: "s1", from_id: "peerB2", kind: "status", text: "Bash: npm run lint", hook_started_at: stopStartedAt + 1 },
  ]);
  await waitFor(() => s.broker.acked.includes("e1") && s.broker.acked.includes("s1"), 3000);
  await delay(100);
  assert.deepEqual(ticking(s).map((i) => i.statuses), [["Bash: npm run lint"]], "the next turn works in a block");
});
