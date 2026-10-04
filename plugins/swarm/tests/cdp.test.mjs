import { test } from "node:test";
import { rejects } from "node:assert/strict";
import { connect } from "../scripts/lib/cdp.mjs";

// A browser that dies mid-probe must fail the probe, not hang it forever.
class FakeSocket extends EventTarget {
  constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
  send() {}
  close() {}
}

const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("still pending")), ms))]);

test("a socket closing rejects every pending call", async () => {
  let socket;
  const client = await connect("ws://x", { _WebSocket: class extends FakeSocket { constructor() { super(); socket = this; } } });
  const pending = client.send("Runtime.evaluate");
  socket.dispatchEvent(new Event("close"));
  await rejects(within(pending, 500), /closed/);
});

test("a socket closing before open rejects the connect", async () => {
  class NeverOpens extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("close"))); }
  }
  await rejects(within(connect("ws://x", { _WebSocket: NeverOpens }), 500), /closed/);
});
