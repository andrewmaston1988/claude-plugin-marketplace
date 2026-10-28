import { test } from "node:test";
import assert from "node:assert/strict";
import { startReplyLoop } from "../../src/core/live-route.mjs";

const log = { warn() {}, error() {} };
const config = { remote: {} };

test("reply loop backs off on superseded before re-arming", async () => {
  const sleeps = [];
  let waits = 0;
  let loop;
  const broker = { wait: async () => {
    waits++;
    if (waits === 1) return { messages: [], superseded: true };
    if (signal.aborted) throw signal.reason;
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } };
  loop = startReplyLoop({ broker, claims: { all: () => ({}) }, web: {}, config, log,
    _sleep: async (ms) => { sleeps.push(ms); loop.stop(); } });
  await loop.done;
  assert.deepEqual(sleeps, [1000]);
  assert.equal(waits, 1);
});

test("reply loop does not ack a reply without a claim", async () => {
  let acked = false;
  let loop;
  let waits = 0;
  const broker = { wait: async (_id, _ms, { signal }) => {
    waits++;
    if (waits === 1) return { messages: [{ from_id: "p1", text: "reply", kind: "text" }], ack: async () => { acked = true; } };
    loop.stop();
    return { messages: [] };
  } };
  loop = startReplyLoop({ broker, claims: { all: () => ({}) }, web: {}, config, log });
  await new Promise((resolve) => setTimeout(resolve, 20));
  loop.stop();
  await loop.done;
  assert.equal(acked, false);
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
    if (signal.aborted) throw signal.reason;
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } };
  const web = { chatPostMessage: async () => { events.push("post"); return { ts: "1" }; } };
  loop = startReplyLoop({ broker, claims: { all: () => ({ channel: { peer_id: "p1" } }) }, web, config, log });
  await loop.done;
  assert.deepEqual(events, ["post", "ack"]);
});
