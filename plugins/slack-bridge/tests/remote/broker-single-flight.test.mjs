import { test } from "node:test";
import assert from "node:assert/strict";
import { createBroker } from "../../src/remote/broker.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const REG = { pid: process.pid, cwd: "", git_root: null, tty: null, summary: "" };

async function startBroker(t, opts = {}) {
  const broker = createBroker(opts);
  t.after(() => broker.close());
  const port = await broker.listen(0);
  const call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return res.json();
  };
  const get = async (path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json();
  const peer = (await call("/register", REG)).id;
  const armed = async () => (await call("/list-peers", { scope: "machine", cwd: "", git_root: null }))[0]?.armed;
  return { call, get, peer, armed, port };
}

const waiter = (pid, started_at) => ({ pid, started_at });

test("an older arm is superseded and consumes nothing", async (t) => {
  const { call, peer } = await startBroker(t);
  const older = call("/wait", { id: peer, timeout_ms: 1000, waiter: waiter(process.pid, 1) });
  await sleep(20);
  const newer = call("/wait", { id: peer, timeout_ms: 1000, waiter: waiter(process.pid, 2) });
  assert.deepEqual(await older, { messages: [], superseded: true });
  await call("/send-message", { from_id: "sender", to_id: peer, text: "new" });
  assert.equal((await newer).messages[0].text, "new");
});

test("a stale arm re-arming after the live arm still loses", async (t) => {
  const { call, peer } = await startBroker(t);
  const live = call("/wait", { id: peer, timeout_ms: 1000, waiter: waiter(process.pid, 20) });
  await sleep(20);
  assert.equal((await call("/wait", { id: peer, timeout_ms: 1000, waiter: waiter(process.pid, 10) })).superseded, true);
  await call("/send-message", { from_id: "sender", to_id: peer, text: "only live" });
  assert.equal((await live).messages[0].text, "only live");
});

test("an unidentified arm is held for its window", async (t) => {
  const { call, peer } = await startBroker(t);
  await call("/wait", { id: peer, timeout_ms: 1000, waiter: waiter(process.pid, 2) });
  const started = Date.now();
  const old = call("/wait", { id: peer, timeout_ms: 120 });
  await sleep(95);
  assert.ok(Date.now() - started >= 95);
  assert.deepEqual(await old, { messages: [], superseded: true });
});

test("take-over re-queues a leased batch", async (t) => {
  const { call, peer } = await startBroker(t);
  await call("/send-message", { from_id: "sender", to_id: peer, text: "leased" });
  const held = await call("/take-messages", { id: peer, lease: true });
  assert.equal(held.messages[0].text, "leased");
  const older = call("/wait", { id: peer, timeout_ms: 1000, lease: true, waiter: waiter(process.pid, 1) });
  await sleep(20);
  const newer = call("/wait", { id: peer, timeout_ms: 1000, lease: true, waiter: waiter(process.pid, 2) });
  assert.deepEqual(await older, { messages: [], superseded: true });
  assert.equal((await newer).messages[0].text, "leased");
});

test("armed ignores a superseded waiter", async (t) => {
  let now = 10_000;
  const { call, peer, armed } = await startBroker(t, { _now: () => new Date(now) });
  const older = call("/wait", { id: peer, timeout_ms: 500 });
  await sleep(20);
  const newer = call("/wait", { id: peer, timeout_ms: 100, waiter: waiter(process.pid, 2) });
  assert.equal((await armed()), true);
  await newer;
  now += 6000;
  assert.equal(await armed(), false);
  assert.deepEqual(await older, { messages: [], superseded: true });
});

// Regression guard: an equal live identity may re-arm at a window boundary.
test("same identity re-arming is not stale", async (t) => {
  const { call, peer } = await startBroker(t);
  const identity = waiter(process.pid, Date.now());
  const first = await call("/wait", { id: peer, timeout_ms: 10, waiter: identity });
  assert.deepEqual(first.messages, []);
  const second = call("/wait", { id: peer, timeout_ms: 1000, waiter: identity });
  await sleep(20);
  await call("/send-message", { from_id: "sender", to_id: peer, text: "re-armed" });
  assert.equal((await second).messages[0].text, "re-armed");
});

// Regression guard: unidentified pre-upgrade arms retain their old behavior.
test("two pre-upgrade arms both consume", async (t) => {
  const { call, peer } = await startBroker(t);
  const first = call("/wait", { id: peer, timeout_ms: 1000 });
  await sleep(20);
  await call("/send-message", { from_id: "sender", to_id: peer, text: "first" });
  assert.equal((await first).messages[0].text, "first");
  const second = call("/wait", { id: peer, timeout_ms: 1000 });
  await sleep(20);
  await call("/send-message", { from_id: "sender", to_id: peer, text: "second" });
  assert.equal((await second).messages[0].text, "second");
});

// Regression guard: the capability was already true for leases before single-flight.
test("/health advertises lease and single_flight", async (t) => {
  const { port } = await startBroker(t);
  const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(h.lease, true);
  assert.equal(h.single_flight, true);
});

// Regression guard: normal waiter completion retains the armed grace.
test("the winner's exit still sets the grace", async (t) => {
  let now = 10_000;
  const { call, peer, armed } = await startBroker(t, { _now: () => new Date(now) });
  const pending = call("/wait", { id: peer, timeout_ms: 1000, waiter: waiter(process.pid, 1) });
  await sleep(20);
  await call("/send-message", { from_id: "sender", to_id: peer, text: "done" });
  await pending;
  assert.equal(await armed(), true);
});

// Regression guard: reap clears grace state.
test("a reaped peer reads unarmed", async (t) => {
  const { call, peer, armed } = await startBroker(t);
  const done = await call("/wait", { id: peer, timeout_ms: 1 });
  assert.deepEqual(done.messages, []);
  await call("/unregister", { id: peer });
  assert.equal(await armed(), undefined);
});

// Regression guard: an ordinary arm leaves a separate take's lease intact.
test("a re-arm with no older waiter leaves the take alone", async (t) => {
  const { call, peer } = await startBroker(t);
  await call("/send-message", { from_id: "sender", to_id: peer, text: "leased take" });
  const take = await call("/take-messages", { id: peer, lease: true });
  await call("/wait", { id: peer, timeout_ms: 10, waiter: waiter(process.pid, 1) });
  assert.equal((await call("/take-messages", { id: peer, lease: true })).messages.length, 0);
  assert.equal(take.messages.length, 1);
});

// The probe is the first call every client makes — arming a waiter probes, and
// a client re-probes before an upgrade. Reaping inside it deletes the queue the
// caller was about to collect, so it must stay side-effect free.
test("a health probe leaves a dead peer's queue intact", async (t) => {
  let dead = false;
  const { call, get, peer } = await startBroker(t, {
    _kill: () => { if (dead) throw new Error("ESRCH"); },
  });
  await call("/send-message", { from_id: "sender", to_id: peer, text: "queued" });
  dead = true;
  assert.equal((await get("/health")).status, "ok");
  const taken = await call("/take-messages", { id: peer });
  assert.deepEqual(taken.messages.map((m) => m.text), ["queued"]);
});

// Reaping still belongs on the routes that own it.
test("list-peers still reaps a dead peer's queue", async (t) => {
  let dead = false;
  const { call, peer } = await startBroker(t, {
    _kill: () => { if (dead) throw new Error("ESRCH"); },
  });
  await call("/send-message", { from_id: "sender", to_id: peer, text: "queued" });
  dead = true;
  assert.deepEqual(await call("/list-peers", { scope: "machine", cwd: "", git_root: null }), []);
  assert.deepEqual((await call("/take-messages", { id: peer })).messages, []);
});

test("a dead identity mark does not block a replacement arm", async (t) => {
  const { call, peer } = await startBroker(t);
  const mark = call("/wait", { id: peer, timeout_ms: 1000, waiter: waiter(2147483647, 999) });
  await sleep(20);
  const replacement = call("/wait", { id: peer, timeout_ms: 1000, waiter: waiter(process.pid, 1) });
  assert.equal((await mark).superseded, true);
  await call("/send-message", { from_id: "sender", to_id: peer, text: "replacement" });
  assert.equal((await replacement).messages[0].text, "replacement");
});
