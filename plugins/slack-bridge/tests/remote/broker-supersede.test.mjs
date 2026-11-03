// /supersede: a turn typed at the terminal retires the last Stop's waiter without
// taking anything, so its messages go to the turn's tool batches and its Stop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { REG, sleep, startBroker } from "./broker-harness.mjs";

const older = { pid: process.pid, started_at: 1_000 };
const prompt = { pid: process.pid, started_at: 2_000 };
const newer = { pid: process.pid, started_at: 3_000 };

async function peer(t) {
  const { call } = await startBroker(t);
  const id = (await call("/register", REG)).body.id;
  return { call, id, wait: (waiter) => call("/wait", { id, waiter, timeout_ms: 2_000, lease: true }) };
}

test("a supersede retires the open waiter and takes nothing", async (t) => {
  const { call, id, wait } = await peer(t);
  const open = wait(older);
  await sleep(50);
  assert.deepEqual((await call("/supersede", { id, waiter: prompt })).body, { ok: true, superseded: 1 });
  assert.deepEqual((await open).body, { messages: [], superseded: true });

  await call("/send-message", { from_id: "slack-bridge", to_id: id, text: "hello" });
  assert.deepEqual((await call("/take-messages", { id })).body.messages.map((m) => m.text), ["hello"]);
});

test("the retired waiter's next window is refused while the superseder lives", async (t) => {
  const { call, id, wait } = await peer(t);
  await call("/supersede", { id, waiter: prompt });
  assert.deepEqual((await wait(older)).body, { messages: [], superseded: true });
});

test("a waiter newer than the supersede keeps the peer", async (t) => {
  const { call, id, wait } = await peer(t);
  const open = wait(newer);
  await sleep(50);
  assert.deepEqual((await call("/supersede", { id, waiter: prompt })).body, { ok: true, superseded: 0 });
  await call("/send-message", { from_id: "slack-bridge", to_id: id, text: "hello" });
  assert.deepEqual((await open).body.messages.map((m) => m.text), ["hello"]);
});

test("a supersede with no identity is refused", async (t) => {
  const { call, id } = await peer(t);
  assert.equal((await call("/supersede", { id })).body.ok, false);
});
