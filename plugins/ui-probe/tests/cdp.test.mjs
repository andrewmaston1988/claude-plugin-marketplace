import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, evaluate } from "../src/cdp.mjs";

class FakeSocket extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.closed = false;
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(frame) { this.sent.push(JSON.parse(frame)); }

  close() {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }

  reply(id, result) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result }) }));
  }

  emit(method, params) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ method, params }) }));
  }
}

function recorder() {
  const sockets = [];
  class Recorded extends FakeSocket {
    constructor(url) { super(url); sockets.push(this); }
  }
  return { sockets, _WebSocket: Recorded };
}

const instant = async () => {};

test("send writes a CDP frame and resolves with the matching reply", async () => {
  const { sockets, _WebSocket } = recorder();
  const client = await connect("ws://127.0.0.1:9/devtools/page/1", { _WebSocket });
  const pending = client.send("Page.enable");
  assert.deepEqual(sockets[0].sent[0], { id: 1, method: "Page.enable", params: {} });
  sockets[0].reply(1, { frameTree: {} });
  assert.deepEqual(await pending, { frameTree: {} });
});

test("a port resolves the first page target", async () => {
  const { sockets, _WebSocket } = recorder();
  const urls = [];
  const _fetch = async (url) => {
    urls.push(url);
    return {
      json: async () => [
        { type: "iframe", webSocketDebuggerUrl: "ws://x/iframe" },
        { type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9/devtools/page/7" },
      ],
    };
  };
  const client = await connect(9333, { _WebSocket, _fetch, _sleep: instant });
  assert.equal(urls[0], "http://127.0.0.1:9333/json/list");
  assert.equal(sockets[0].url, "ws://127.0.0.1:9/devtools/page/7");
  assert.equal(typeof client.send, "function");
});

test("a page target that is not up yet is polled for", async () => {
  const { _WebSocket } = recorder();
  let calls = 0;
  const _fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error("connection refused");
    return { json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://x/page" }] };
  };
  await connect(9333, { _WebSocket, _fetch, _sleep: instant });
  assert.equal(calls, 2);
});

test("a missing page target fails after the poll window", async () => {
  const { _WebSocket } = recorder();
  const _fetch = async () => ({ json: async () => [] });
  await assert.rejects(connect(9333, { _WebSocket, _fetch, _sleep: instant }), /no page target/);
});

test("a call with no reply times out", async () => {
  const { _WebSocket } = recorder();
  const client = await connect("ws://x", { _WebSocket, timeoutMs: 20 });
  await assert.rejects(client.send("Runtime.evaluate"), /Runtime\.evaluate timed out after 20ms/);
});

test("a socket closing rejects every pending call", async () => {
  const { sockets, _WebSocket } = recorder();
  const client = await connect("ws://x", { _WebSocket });
  const pending = client.send("Runtime.evaluate");
  sockets[0].close();
  await assert.rejects(pending, /closed/);
});

test("a socket closing before open rejects connect", async () => {
  class NeverOpens extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("close"))); }
  }
  await assert.rejects(connect("ws://x", { _WebSocket: NeverOpens }), /closed/);
});

test("events reach their listeners until unsubscribed", async () => {
  const { sockets, _WebSocket } = recorder();
  const client = await connect("ws://x", { _WebSocket });
  const seen = [];
  const off = client.on("Fetch.requestPaused", (params) => seen.push(params.requestId));
  sockets[0].emit("Fetch.requestPaused", { requestId: "a" });
  off();
  sockets[0].emit("Fetch.requestPaused", { requestId: "b" });
  assert.deepEqual(seen, ["a"]);
});

test("a throwing listener does not stop the others", async () => {
  const { sockets, _WebSocket } = recorder();
  const client = await connect("ws://x", { _WebSocket });
  const seen = [];
  client.on("Page.loadEventFired", () => { throw new Error("listener bug"); });
  client.on("Page.loadEventFired", (params) => seen.push(params.timestamp));
  sockets[0].emit("Page.loadEventFired", { timestamp: 1 });
  assert.deepEqual(seen, [1]);
});

test("evaluate returns the value, and throws on a page exception", async () => {
  const value = await evaluate({ send: async () => ({ result: { value: 42 } }) }, "6 * 7");
  assert.equal(value, 42);
  const thrown = {
    send: async () => ({ exceptionDetails: { exception: { description: "TypeError: nope" } } }),
  };
  await assert.rejects(evaluate(thrown, "nope()"), /TypeError: nope/);
});
