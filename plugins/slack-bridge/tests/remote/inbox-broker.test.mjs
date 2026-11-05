// The inbox hook's delivery contract against a real broker: a take holds the row
// until the ack, and the entry point delivers end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createBrokerClient } from "../../src/remote/broker-client.mjs";
import { PRIMING_LINE } from "../../src/remote/waiter.mjs";
import { REG, claimedSession, runEntry, sleep, startBroker } from "./broker-harness.mjs";

const SID = "sess-1";
const entry = fileURLToPath(new URL("../../hooks/inbox-hook.mjs", import.meta.url));
const LEASE_MS = 150;

async function queued(t, text = "stop that") {
  const { port, call } = await startBroker(t, { _leaseMs: LEASE_MS });
  const peer = (await call("/register", REG)).body.id;
  await call("/send-message", { from_id: "sender", to_id: peer, text });
  return { port, call, peer, client: createBrokerClient({ port }) };
}

test("a leased take holds the row: a second take in the lease sees nothing", async (t) => {
  const { client, peer } = await queued(t);
  assert.equal((await client.takeLeased(peer)).messages.length, 1);
  assert.deepEqual((await client.takeLeased(peer)).messages, []);
});

test("a take with no ack comes back when the lease runs out", async (t) => {
  const { client, peer } = await queued(t);
  await client.takeLeased(peer);
  await sleep(LEASE_MS * 2);
  assert.deepEqual((await client.takeLeased(peer)).messages.map((m) => m.text), ["stop that"]);
});

test("an ack clears the row for good", async (t) => {
  const { client, peer } = await queued(t);
  await (await client.takeLeased(peer)).ack();
  await sleep(LEASE_MS * 2);
  assert.deepEqual((await client.takeLeased(peer)).messages, []);
});

const deliver = (t, port, peer) =>
  runEntry([entry], claimedSession(t, { port, peer, sid: SID }), { session_id: SID, hook_event_name: "PostToolBatch" });

test("the entry hands a claimed session its message and clears the row", async (t) => {
  const { port, peer, client } = await queued(t);
  const r = await deliver(t, port, peer);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: `${PRIMING_LINE}\nSLACK: stop that\n` },
  });
  await sleep(LEASE_MS * 2);
  assert.deepEqual((await client.takeLeased(peer)).messages, []);
});

test("the entry exits clean with nothing queued", async (t) => {
  const { port, peer, client } = await queued(t);
  await (await client.takeLeased(peer)).ack();
  const r = await deliver(t, port, peer);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
});
