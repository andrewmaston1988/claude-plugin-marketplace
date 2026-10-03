import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createSocketModeClient } from "../src/socket-mode/index.mjs";

function makeLog() {
  const entries = [];
  return {
    info: (m, x) => entries.push({ l: "info", m, x }),
    warn: (m, x) => entries.push({ l: "warn", m, x }),
    error: (m, x) => entries.push({ l: "error", m, x }),
    entries,
  };
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Stub WebSocket that lets tests push messages and inspect sends.
// Buffers outbound events until listeners attach.
class StubWS {
  constructor() {
    this.readyState = 1;
    this.OPEN = 1;
    this.sent = [];
    this._listeners = {};
  }
  addEventListener(event, fn) {
    this._listeners[event] = this._listeners[event] ?? [];
    this._listeners[event].push(fn);
  }
  removeEventListener(event, fn) {
    this._listeners[event] = (this._listeners[event] ?? []).filter(f => f !== fn);
  }
  _emit(event, evt) {
    for (const fn of this._listeners[event] ?? []) fn(evt);
  }
  send(data) { this.sent.push(typeof data === "string" ? JSON.parse(data) : data); }
  close() {
    this.readyState = 3;
    this._emit("close", { code: 1000, reason: "test close" });
  }
  // Test helper: fire open (called after async setup completes)
  open() { this._emit("open", { type: "open" }); }
  // Test helper: push a JSON message
  receive(obj) { this._emit("message", { data: JSON.stringify(obj) }); }
}

function makeClientWithStub() {
  const stub = new StubWS();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ ok: true, url: "wss://stub.example.com" }) });
  const log = makeLog();
  const client = createSocketModeClient({
    appToken: "xapp-test",
    log,
    _WebSocket: function() { return stub; },
  });
  return { client, log, stub, restore: () => { globalThis.fetch = origFetch; } };
}

async function connectStub({ client, stub }) {
  client.start();
  await delay(10); // let getWssUrl() promise resolve and socket setup complete
  stub.open();
  stub.receive({ type: "hello" });
}

test("socket-mode — hello message emits connect event", async () => {
  const { client, stub, restore } = makeClientWithStub();
  let connected = false;
  client.on("connect", () => { connected = true; });
  await connectStub({ client, stub });
  await delay(10);
  assert.ok(connected, "connect event should fire after hello");
  restore(); client.stop();
});

test("socket-mode — events_api envelope emits event with payload and ack", async () => {
  const { client, stub, restore } = makeClientWithStub();
  const events = [];
  client.on("event", ({ payload, ack }) => { events.push(payload); ack(); });
  await connectStub({ client, stub });
  stub.receive({ type: "events_api", envelope_id: "env-1", payload: { type: "message", text: "hi" } });
  await delay(10);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: "message", text: "hi" });
  assert.ok(stub.sent.some(s => s.envelope_id === "env-1"), "ack should send envelope_id back");
  restore(); client.stop();
});

test("socket-mode — calling ack sends envelope_id over socket", async () => {
  const { client, stub, restore } = makeClientWithStub();
  let capturedAck;
  client.on("event", ({ ack }) => { capturedAck = ack; });
  await connectStub({ client, stub });
  stub.receive({ type: "events_api", envelope_id: "ack-test", payload: {} });
  await delay(10);
  assert.ok(typeof capturedAck === "function", "ack should be a function");
  capturedAck();
  assert.ok(stub.sent.some(s => s.envelope_id === "ack-test"));
  restore(); client.stop();
});

test("socket-mode — disconnect with link_disabled does not schedule reconnect", async () => {
  const { client, log, stub, restore } = makeClientWithStub();
  await connectStub({ client, stub });
  stub.receive({ type: "disconnect", reason: "link_disabled" });
  await delay(20);
  const reconnects = log.entries.filter(e => e.m?.includes("scheduling reconnect"));
  assert.equal(reconnects.length, 0, "link_disabled should not trigger reconnect");
  restore(); client.stop();
});

test("socket-mode — disconnect with warning reason schedules reconnect", async () => {
  const { client, log, stub, restore } = makeClientWithStub();
  await connectStub({ client, stub });
  stub.receive({ type: "disconnect", reason: "warning" });
  await delay(20);
  assert.ok(log.entries.some(e => e.m?.includes("scheduling reconnect")), "should schedule reconnect");
  restore(); client.stop();
});

test("socket-mode — no client-sent ping; stays open without pong-timeout reconnect", async () => {
  const { client, log, stub, restore } = makeClientWithStub();
  await connectStub({ client, stub });
  await delay(30);
  // Slack Socket Mode keepalive is server-driven (server pings us; we pong).
  // A client→server {type:"ping"} is never answered, so sending one only
  // causes a perpetual pong-timeout reconnect churn. The bridge must NOT send
  // a client ping, must not pong-timeout, and must keep the socket open.
  assert.ok(!stub.sent.some(s => s.type === "ping"), "must not send a client ping");
  assert.ok(!log.entries.some(e => e.m?.includes("pong timeout")), "no pong-timeout reconnect");
  assert.ok(!log.entries.some(e => e.m?.includes("scheduling reconnect")), "no reconnect while open");
  assert.equal(stub.readyState, 1, "socket stays open");
  restore(); client.stop();
});

test("socket-mode — server ping receives pong reply with reply_to", async () => {
  const { client, stub, restore } = makeClientWithStub();
  await connectStub({ client, stub });
  const sentBefore = stub.sent.length;
  stub.receive({ type: "ping", reply_to: 42 });
  await delay(10);
  const replies = stub.sent.slice(sentBefore);
  const pong = replies.find(s => s.type === "pong");
  assert.ok(pong, "should send a pong in response to server ping");
  assert.equal(pong.reply_to, 42, "pong reply_to should match ping reply_to");
  restore(); client.stop();
});

// Item 6: a half-open socket never fires `close`, so only a frame-silence
// watchdog notices it. Each connect gets a fresh stub so reconnects are countable.
function makeClientWithStubs({ staleMs }) {
  const stubs = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ ok: true, url: "wss://stub.example.com" }) });
  const log = makeLog();
  const client = createSocketModeClient({
    appToken: "xapp-test",
    log,
    _WebSocket: function() { const s = new StubWS(); stubs.push(s); return s; },
    _staleMs: staleMs,
  });
  return { client, log, stubs, restore: () => { globalThis.fetch = origFetch; } };
}

test("socket-mode — no frame for longer than the watchdog window → socket closed and reconnected", async () => {
  const { client, log, stubs, restore } = makeClientWithStubs({ staleMs: 50 });
  client.start();
  await delay(10);
  stubs[0].open();
  stubs[0].receive({ type: "hello" });
  // Silent from here: the watchdog fires at 50 ms, the first backoff is 1 s.
  await delay(1300);
  assert.equal(stubs[0].readyState, 3, "the silent socket must be force-closed");
  assert.ok(stubs.length >= 2, `a new socket must be opened, got ${stubs.length}`);
  assert.ok(log.entries.some(e => e.m?.includes("no frame")), "the watchdog logs why it reconnected");
  restore(); client.stop();
});

test("socket-mode — frames inside the watchdog window → no reconnect", async () => {
  const { client, log, stubs, restore } = makeClientWithStubs({ staleMs: 80 });
  client.start();
  await delay(10);
  stubs[0].open();
  stubs[0].receive({ type: "hello" });
  for (let i = 0; i < 15; i++) {
    await delay(25);
    stubs[0].receive({ type: "ping", reply_to: i });
  }
  assert.equal(stubs[0].readyState, 1, "a socket that keeps receiving frames stays open");
  assert.equal(stubs.length, 1);
  assert.ok(!log.entries.some(e => e.m?.includes("scheduling reconnect")));
  restore(); client.stop();
});

test("socket-mode — a URL fetch that never settles → the watchdog retries the connect", async () => {
  const origFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => { fetches++; return new Promise(() => {}); };
  const client = createSocketModeClient({ appToken: "xapp-test", log: makeLog(), _WebSocket: function() { return new StubWS(); }, _staleMs: 50 });
  client.start();
  await delay(1300);
  client.stop(); globalThis.fetch = origFetch;
  assert.ok(fetches >= 2, `a hung connect must be retried, got ${fetches} fetch(es)`);
});

test("socket-mode — a handshake that never opens → the watchdog reconnects", async () => {
  const { client, stubs, restore } = makeClientWithStubs({ staleMs: 50 });
  client.start();
  await delay(1300);
  assert.equal(stubs[0].readyState, 3, "the never-opened socket must be closed");
  assert.ok(stubs.length >= 2, `a new socket must be opened, got ${stubs.length}`);
  restore(); client.stop();
});

test("socket-mode — a late frame on an abandoned socket does not disarm the live socket's watchdog", async () => {
  const { client, stubs, restore } = makeClientWithStubs({ staleMs: 50 });
  client.start();
  await delay(10);
  stubs[0].open();
  stubs[0].receive({ type: "hello" });
  // Silent → the watchdog abandons stubs[0] and reconnects; open stubs[1] at once.
  while (stubs.length < 2) await delay(5);
  stubs[1].open();
  stubs[1].receive({ type: "hello" });
  stubs[0].receive({ type: "ping", reply_to: 1 }); // late frame from the abandoned socket
  await delay(1300); // stubs[1] is silent too, so its watchdog must still fire
  assert.ok(stubs.length >= 3, `the live socket's watchdog must survive the late frame, got ${stubs.length} sockets`);
  restore(); client.stop();
});

test("socket-mode — a connect the watchdog gave up on does not open a second socket when it lands late", async () => {
  const origFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => {
    const n = ++fetches;
    const res = { json: async () => ({ ok: true, url: "wss://stub.example.com" }) };
    return n === 1 ? new Promise(r => setTimeout(() => r(res), 1200)) : Promise.resolve(res);
  };
  const stubs = [];
  const client = createSocketModeClient({
    appToken: "xapp-test", log: makeLog(), _staleMs: 50,
    _WebSocket: function() { const s = new StubWS(); stubs.push(s); return s; },
  });
  client.start();
  while (stubs.length < 1) await delay(5); // the watchdog's retry connected
  stubs[0].open();
  stubs[0].receive({ type: "hello" });
  const keepAlive = setInterval(() => stubs[0].receive({ type: "ping", reply_to: 0 }), 20);
  await delay(400); // the first, abandoned fetch resolves meanwhile
  clearInterval(keepAlive);
  client.stop(); globalThis.fetch = origFetch;
  assert.equal(stubs.length, 1, "the late first connect must not open a second socket");
});
