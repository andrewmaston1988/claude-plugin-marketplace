import { test } from "node:test";
import assert from "node:assert/strict";
import { routeToLiveSession, startReplyLoop } from "../../src/core/live-route.mjs";

const log = { warn() {}, error() {} };
const config = { remote: {} };

test("reply loop backs off on superseded before re-arming", async () => {
  const sleeps = [];
  let waits = 0;
  let loop;
  const broker = { wait: async () => {
    waits++;
    if (waits === 1) return { messages: [], superseded: true };
    loop.stop();
    return { messages: [] };
  } };
  loop = startReplyLoop({ broker, claims: { all: () => ({}) }, web: {}, config, log,
    _sleep: async (ms) => { sleeps.push(ms); loop.stop(); } });
  await loop.done;
  assert.deepEqual(sleeps, [1000]);
  assert.equal(waits, 1);
});

test("reply loop acks posted replies from a partially unclaimed batch", async () => {
  let ackedIds = null;
  let loop;
  let waits = 0;
  const broker = { wait: async () => {
    waits++;
    if (waits === 1) return {
      messages: [
        { id: "posted-id", from_id: "p1", text: "reply", kind: "text" },
        { id: "unclaimed-id", from_id: "ghost", text: "orphan", kind: "text" },
      ],
      ack: async (ids) => { ackedIds = ids; loop.stop(); },
    };
    loop.stop();
    return { messages: [] };
  } };
  const web = { chatPostMessage: async () => ({ ts: "1" }) };
  loop = startReplyLoop({ broker, claims: { all: () => ({ channel: { peer_id: "p1" } }) }, web, config, log });
  await new Promise((resolve) => setTimeout(resolve, 20));
  loop.stop();
  await loop.done;
  assert.deepEqual(ackedIds, ["posted-id"]);
});

test("reply loop acks only the chunks posted before a later chunk fails", async () => {
  const ackCalls = [];
  let waits = 0;
  let loop;
  const broker = { sendMessage: async () => ({ ok: true }), wait: async () => {
    waits++;
    if (waits > 1) { loop.stop(); return { messages: [] }; }
    return {
      messages: [
        { id: "chunk-1", from_id: "chunk-peer", text: "first chunk", kind: "text" },
        { id: "chunk-2", from_id: "chunk-peer", text: "second chunk", kind: "text" },
      ],
      ack: async (ids) => ackCalls.push(ids)
    };
  } };
  const web = {
    chatPostMessage: async ({ text }) => {
      if (!text) return { ts: "placeholder-ts" };
      throw new Error("second chunk unavailable");
    },
    chatUpdate: async () => ({}),
    chatDelete: async () => ({}),
  };
  await routeToLiveSession({
    web, channel: "C1", text: "request", claim: { peer_id: "chunk-peer" }, broker,
    config: { remote: { replyTimeoutMs: 60_000 } }, log: { ...log, child: () => log },
    _startHeartbeat: () => ({ stop: async () => {} }),
  });
  loop = startReplyLoop({ broker, claims: { all: () => ({ C1: { peer_id: "chunk-peer" } }) }, web, config, log });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  loop.stop();
  await loop.done;
  assert.deepEqual(ackCalls, [["chunk-1"]]);
});

test("reply loop acks after the Slack post succeeds", async () => {
  const events = [];
  let loop;
  let waits = 0;
  const broker = { wait: async (_id, _ms, { signal }) => {
    waits++;
    if (waits === 1) return {
      messages: [{ from_id: "p1", text: "reply", kind: "text" }],
      ack: async () => { events.push("ack"); loop.stop(); },
    };
    loop.stop();
    return { messages: [] };
  } };
  const web = { chatPostMessage: async () => { events.push("post"); return { ts: "1" }; } };
  loop = startReplyLoop({ broker, claims: { all: () => ({ channel: { peer_id: "p1" } }) }, web, config, log });
  await loop.done;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ["post", "ack"]);
});

// Regression guard: a failed Slack post must leave its leased reply unacked.
test("reply loop does not ack when the Slack post fails", async () => {
  let acked = false;
  let loop;
  let waits = 0;
  const broker = { wait: async () => {
    waits++;
    if (waits === 1) return {
      messages: [{ from_id: "p1", text: "reply", kind: "text" }],
      ack: async () => { acked = true; },
    };
    loop.stop();
    return { messages: [] };
  } };
  const web = { chatPostMessage: async () => { throw new Error("Slack unavailable"); } };
  loop = startReplyLoop({ broker, claims: { all: () => ({ channel: { peer_id: "p1" } }) }, web, config, log });
  await new Promise((resolve) => setTimeout(resolve, 20));
  loop.stop();
  await loop.done;
  assert.equal(acked, false);
});
