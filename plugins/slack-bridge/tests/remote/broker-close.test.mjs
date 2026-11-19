// broker.close() and /shutdown must end their sockets, not idle them out: a
// client's pooled keep-alive connection otherwise holds the close for the
// socket's idle timeout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBroker } from "../../src/remote/broker.mjs";
import { createBrokerClient } from "../../src/remote/broker-client.mjs";
import { startReplyLoop } from "../../src/core/handler.mjs";
import { tmpState, sleep } from "./broker-harness.mjs";

function silentLog() {
  const log = { info() {}, warn() {}, error() {}, child: () => log };
  return log;
}

// The shape every per-session teardown is in: one /wait window in flight on the
// client's pooled socket, then aborted mid-window.
async function abortedLongPoll(opts = {}) {
  const broker = createBroker({ stateFile: tmpState(), ...opts });
  const port = await broker.listen(0);
  const client = createBrokerClient({ port });
  const loop = startReplyLoop({ broker: client, claims: { all: () => ({}) }, web: {}, config: {}, log: silentLog() });
  await sleep(100);
  loop.stop();
  await loop.done;
  return { broker, port };
}

test("broker — close() ends promptly with an aborted long-poll client attached", async () => {
  const { broker } = await abortedLongPoll();

  const t0 = Date.now();
  await broker.close();
  const took = Date.now() - t0;
  assert.ok(took < 1000,
    `broker.close() took ${took} ms with the long-poll client attached — it idled out a keep-alive socket instead of tearing it down`);
});

// Shutdown must not wait out a live long-poll either: the reply loop holds a /wait
// window open for 55 s at a time, and stopping the bridge cannot take that long.
test("broker — /shutdown ends promptly with a long-poll in flight", async () => {
  let closed;
  const shutdownDone = new Promise((resolve) => { closed = resolve; });
  const broker = createBroker({ stateFile: tmpState(), onShutdown: closed });
  const port = await broker.listen(0);
  // A parked /wait, short enough that the unfixed path still terminates.
  const parked = fetch(`http://127.0.0.1:${port}/wait`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "peer-1", timeout_ms: 1500 }),
  }).catch(() => { /* the shutdown tears the socket down */ });
  await sleep(100); // the request has reached the server and parked

  const t0 = Date.now();
  await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST" });
  await shutdownDone;
  const took = Date.now() - t0;
  await parked;
  assert.ok(took < 1000,
    `the /shutdown route took ${took} ms to close with a long-poll in flight — it waited out the waiter's window instead of tearing it down`);
});
