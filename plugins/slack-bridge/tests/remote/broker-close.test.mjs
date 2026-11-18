// broker.close() must tear connections down, not idle past them. The daemon reply
// loop talks to this broker over a pooled keep-alive HTTP connection; abort it
// mid-/wait and a bare server.close() idles until the socket's keep-alive timer
// expires (~4s). Every startSession teardown in the lifecycle suite is in exactly
// this shape — loop aborted mid-window, then broker.close() — so the suite paid a
// ~3s tail on each failed/interrupted ending. close() must end the sockets itself.
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

test("broker — close() ends promptly with an aborted long-poll client attached", async () => {
  const broker = createBroker({ stateFile: tmpState() });
  const port = await broker.listen(0);
  const client = createBrokerClient({ port });
  const loop = startReplyLoop({ broker: client, claims: { all: () => ({}) }, web: {}, config: {}, log: silentLog() });
  await sleep(100); // one /wait window in flight; the client's pooled socket is open
  loop.stop();      // abort mid-window — the shape every per-session teardown is in
  await loop.done;

  const t0 = Date.now();
  await broker.close();
  const took = Date.now() - t0;
  assert.ok(took < 1000,
    `broker.close() took ${took} ms with the long-poll client attached — it idled out a keep-alive socket instead of tearing it down`);
});
