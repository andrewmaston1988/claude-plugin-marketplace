import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrokerClient } from "../../src/remote/broker-client.mjs";

test("wait: the retry after a connection error keeps the caller's abort signal", async () => {
  const signals = [];
  const _fetch = async (url, opts = {}) => {
    if (url.endsWith("/health")) return { ok: true, json: async () => ({ status: "ok", lease: true }) };
    signals.push(opts.signal);
    if (signals.length === 1) throw new TypeError("fetch failed");
    return { ok: true, json: async () => [] };
  };
  const client = createBrokerClient({ port: 1, _fetch });
  const signal = AbortSignal.timeout(60_000);
  await client.wait("p1", 55_000, { signal });
  assert.equal(signals.length, 2);
  assert.equal(signals[1], signal);
});

// Item 10: wait and takeMessages ask for a lease and ack what they received, so a
// response lost on the wire is redelivered instead of dropped.
for (const [name, call] of [["wait", (c) => c.wait("p1", 55_000)], ["takeMessages", (c) => c.takeMessages("p1")]]) {
  test(`${name}: requests a lease and acks the ids it received`, async () => {
    const calls = [];
    const _fetch = async (url, opts = {}) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: JSON.parse(opts.body) });
      const body = path === "/ack" ? { ok: true } : { messages: [{ id: 7, text: "a" }, { id: 9, text: "b" }] };
      return { ok: true, json: async () => body };
    };
    const res = await call(createBrokerClient({ port: 1, _fetch }));
    assert.deepEqual(res.messages.map((m) => m.id), [7, 9]);
    assert.equal(calls[0].body.lease, true);
    assert.deepEqual(calls[1], { path: "/ack", body: { id: "p1", ids: [7, 9] } });
  });
}

test("takeMessages: a failed ack still returns the messages (the lease redelivers)", async () => {
  const _fetch = async (url) => {
    if (url.endsWith("/ack")) return { ok: false, status: 404, text: async () => "not found" };
    return { ok: true, json: async () => ({ messages: [{ id: 1, text: "a" }] }) };
  };
  const res = await createBrokerClient({ port: 1, _fetch }).takeMessages("p1");
  assert.deepEqual(res.messages.map((m) => m.text), ["a"]);
});

// A broker from before leases consumes on take, so a lost response loses the
// message. /health advertises `lease`; ensureBroker replaces a broker without it.
test("ensureBroker: replaces a running broker that does not advertise leases", async () => {
  const calls = [];
  let up = true;
  let spawned = 0;
  const _fetch = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === "/shutdown") { up = false; return { ok: true, json: async () => ({}) }; }
    if (path === "/health") {
      if (!up) throw new TypeError("fetch failed");
      return { ok: true, json: async () => (spawned ? { status: "ok", lease: true } : { status: "ok" }) };
    }
    throw new Error(`unexpected ${path}`);
  };
  const _spawn = () => { spawned++; up = true; return { unref() {} }; };
  await createBrokerClient({ port: 1, _fetch, _spawn }).ensureBroker();
  assert.ok(calls.includes("/shutdown"), "old broker was asked to shut down");
  assert.equal(spawned, 1);
});

test("ensureBroker: a pre-lease broker that refuses /shutdown is an error, not accepted", async () => {
  const _fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/shutdown") return { ok: false, status: 401, json: async () => ({}) };
    if (path === "/health") return { ok: true, json: async () => ({ status: "ok" }) };
    throw new Error(`unexpected ${path}`);
  };
  const client = createBrokerClient({ port: 1, _fetch, _spawn: () => ({ unref() {} }), _sleep: async () => {} });
  await assert.rejects(client.ensureBroker(), /predates leased takes/);
});

test("ensureBroker: keeps a running broker that advertises leases", async () => {
  let spawned = 0;
  const _fetch = async (url) => {
    if (url.endsWith("/health")) return { ok: true, json: async () => ({ status: "ok", lease: true }) };
    throw new Error(`unexpected ${url}`);
  };
  await createBrokerClient({ port: 1, _fetch, _spawn: () => { spawned++; return { unref() {} }; } }).ensureBroker();
  assert.equal(spawned, 0);
});
