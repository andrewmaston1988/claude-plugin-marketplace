// Forked/trimmed from plugins/claude-peers/tests/broker.test.mjs. The internal
// broker routes messages between the slack-bridge daemon (peer "slack-bridge")
// and a live interactive session's MCP server. Same wire protocol as claude-peers
// (distinct port: 7898, not 7899) so the battle-tested patterns carry over.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBroker } from "../../src/remote/broker.mjs";

function tmpState() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "slack-remote-broker-")), "state.json");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startBroker(t, opts = {}) {
  const broker = createBroker({ stateFile: opts.stateFile ?? tmpState(), ...opts });
  t.after(() => broker.close());
  const port = await broker.listen(0);
  const call = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const armed = async (id) => {
    const { body: peers } = await call("/list-peers", { scope: "machine", cwd: "x", git_root: null });
    return peers.find((p) => p.id === id)?.armed;
  };
  return { broker, port, call, armed };
}

const REG = { pid: process.pid, cwd: "C:/work/a", git_root: "C:/work/a", tty: null, summary: "live session" };

test("register assigns an 8-char id and the peer appears in list-peers", async (t) => {
  const { call } = await startBroker(t);
  const { body: reg } = await call("/register", REG);
  assert.match(reg.id, /^[a-z0-9]{8}$/);
  const { body: peers } = await call("/list-peers", { scope: "machine", cwd: "x", git_root: null });
  assert.equal(peers.length, 1);
  assert.equal(peers[0].id, reg.id);
});

test("heartbeat advances last_seen", async (t) => {
  let now = 1000;
  const { call } = await startBroker(t, { _now: () => new Date(now) });
  const { body: reg } = await call("/register", REG);
  now = 5000;
  await call("/heartbeat", { id: reg.id });
  const { body: peers } = await call("/list-peers", { scope: "machine", cwd: "x", git_root: null });
  assert.equal(peers[0].last_seen, new Date(5000).toISOString());
});

test("send-message queues; take-messages consumes once; a second take is empty", async (t) => {
  const { call } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  const sent = await call("/send-message", { from_id: a.id, to_id: b.id, text: "hello" });
  assert.equal(sent.body.ok, true);
  const first = await call("/take-messages", { id: b.id });
  assert.deepEqual(first.body.messages.map((m) => m.text), ["hello"]);
  const second = await call("/take-messages", { id: b.id });
  assert.equal(second.body.messages.length, 0);
});

// The daemon sends as the fixed id "slack-bridge" without ever calling /register.
// It must be auto-registered as an adhoc peer so the live session can reply to it.
test("send-message from an unknown sender (slack-bridge) auto-registers adhoc; reply routes back", async (t) => {
  const { call } = await startBroker(t);
  const { body: reg } = await call("/register", REG);
  const send = await call("/send-message", { from_id: "slack-bridge", to_id: reg.id, text: "from slack" });
  assert.equal(send.body.ok, true);
  const reply = await call("/send-message", { from_id: reg.id, to_id: "slack-bridge", text: "ack" });
  assert.equal(reply.body.ok, true, `reply failed: ${reply.body.error}`);
  const { body: taken } = await call("/take-messages", { id: "slack-bridge" });
  assert.deepEqual(taken.messages.map((m) => m.text), ["ack"]);
});

test("dead peers are reaped on list-peers and their undelivered messages dropped", async (t) => {
  const dead = new Set();
  const _kill = (pid) => { if (dead.has(pid)) throw new Error("ESRCH"); };
  const { call } = await startBroker(t, { _kill });
  const { body: a } = await call("/register", { ...REG, pid: 111 });
  const { body: b } = await call("/register", { ...REG, pid: 222 });
  await call("/send-message", { from_id: b.id, to_id: a.id, text: "never delivered" });
  dead.add(111);
  const { body: peers } = await call("/list-peers", { scope: "machine", cwd: "x", git_root: null });
  assert.deepEqual(peers.map((p) => p.id), [b.id]);
});

test("unregister removes a peer", async (t) => {
  const { call } = await startBroker(t);
  const { body: reg } = await call("/register", REG);
  await call("/unregister", { id: reg.id });
  const { body: peers } = await call("/list-peers", { scope: "machine", cwd: "x", git_root: null });
  assert.equal(peers.length, 0);
});

test("a corrupt state file is quarantined loudly, not silently overwritten", async (t) => {
  const stateFile = tmpState();
  fs.writeFileSync(stateFile, "{ definitely not json");
  const logged = [];
  const broker = createBroker({ stateFile, log: (m) => logged.push(m) });
  t.after(() => broker.close());
  const port = await broker.listen(0);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.status, "ok");
  assert.ok(logged.some((m) => /corrupt/i.test(m)), "must log the quarantine");
  const quarantined = fs.readdirSync(path.dirname(stateFile)).filter((f) => f.includes("corrupt"));
  assert.equal(quarantined.length, 1, "corrupt file must be preserved, not deleted");
});

test("state survives a broker restart via the state file", async () => {
  const stateFile = tmpState();
  const b1 = createBroker({ stateFile });
  const port1 = await b1.listen(0);
  const reg = await (await fetch(`http://127.0.0.1:${port1}/register`, { method: "POST", body: JSON.stringify(REG) })).json();
  await b1.close();
  const b2 = createBroker({ stateFile });
  const port2 = await b2.listen(0);
  const peers = await (await fetch(`http://127.0.0.1:${port2}/list-peers`, { method: "POST", body: JSON.stringify({ scope: "machine", cwd: "x", git_root: null }) })).json();
  assert.deepEqual(peers.map((p) => p.id), [reg.id]);
  await b2.close();
});

test("GET /health reports ok and a peer count", async (t) => {
  const { port } = await startBroker(t);
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(typeof body.peers, "number");
});

test("POST /shutdown closes the broker gracefully", async (t) => {
  let shutdownCalled = false;
  const { port, call } = await startBroker(t, { onShutdown: () => { shutdownCalled = true; } });
  const { body } = await call("/shutdown", {});
  assert.equal(body.ok, true);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(shutdownCalled, true, "onShutdown hook must fire");
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }));
});

test("unknown POST path is a 404", async (t) => {
  const { call } = await startBroker(t);
  const notFound = await call("/no-such", {});
  assert.equal(notFound.status, 404);
});

// --- queue retention ---
// A queued message must reach check_messages — the documented recovery — even if
// nothing long-polled it. /take-messages is the consumer; the 24 h retention only
// clears residue a pre-upgrade broker marked delivered (the push that set that
// flag is gone with /poll-messages).

test("a queued message survives to take-messages with nothing polling it", async (t) => {
  const { call } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "missed while idle" });
  const { body: taken } = await call("/take-messages", { id: b.id });
  assert.deepEqual(taken.messages.map((m) => m.text), ["missed while idle"],
    "a queued-but-unseen message must survive to check_messages");
});

test("take-messages consumes: a second take returns nothing", async (t) => {
  const { call } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "once" });
  assert.equal((await call("/take-messages", { id: b.id })).body.messages.length, 1);
  assert.equal((await call("/take-messages", { id: b.id })).body.messages.length, 0);
});

test("a message /wait delivered does not resurface in take-messages (one consumer)", async (t) => {
  const { call } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "delivered by the waiter" });
  const { body: waited } = await call("/wait", { id: b.id, timeout_ms: 1000 });
  assert.deepEqual(waited.messages.map((m) => m.text), ["delivered by the waiter"]);
  const { body: taken } = await call("/take-messages", { id: b.id });
  assert.equal(taken.messages.length, 0, "a message /wait consumed must not be served again");
});

test("delivered residue is purged past the retention window; an undelivered message is kept", async (t) => {
  let now = Date.parse("2026-09-17T12:00:00Z");
  const stateFile = tmpState();
  const at = new Date(now).toISOString();
  fs.writeFileSync(stateFile, JSON.stringify({
    peers: { p1: { id: "p1", pid: 111, cwd: "", git_root: null, tty: null, summary: "", kind: "session", registered_at: at, last_seen: at } },
    messages: [
      { id: 1, from_id: "p2", to_id: "p1", text: "delivered residue", sent_at: at, delivered: true },
      { id: 2, from_id: "p2", to_id: "p1", text: "still pending", sent_at: at, delivered: false },
    ],
  }));
  const { call } = await startBroker(t, { stateFile, _now: () => new Date(now), _kill: () => {} });
  now += 25 * 60 * 60 * 1000;
  await call("/list-peers", { scope: "machine", cwd: "x", git_root: null }); // reapDead triggers the purge
  const { body: taken } = await call("/take-messages", { id: "p1" });
  assert.deepEqual(taken.messages.map((m) => m.text), ["still pending"],
    "the delivered residue goes, an undelivered message stays");
});

test("reaping a dead peer drops its queued messages", async (t) => {
  const stateFile = tmpState();
  const dead = new Set();
  const _kill = (pid) => { if (dead.has(pid)) throw new Error("ESRCH"); };
  const { call } = await startBroker(t, { stateFile, _kill });
  const { body: a } = await call("/register", { ...REG, pid: 111 });
  const { body: b } = await call("/register", { ...REG, pid: 222 });
  await call("/send-message", { from_id: b.id, to_id: a.id, text: "retained" });
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).messages.length, 1,
    "a queued message must be retained in state");
  dead.add(111);
  await call("/list-peers", { scope: "machine", cwd: "x", git_root: null });
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).messages.length, 0,
    "a reaped peer must not leak its queue");
});

// --- reserved recipient (the daemon never /register s) ---
// slack_post routes replies as to_id "slack-bridge". The daemon only ever
// appears as an ad-hoc sender, which the 1 h ad-hoc reap removes — so the
// recipient must materialise on demand and survive every reap, or every reply
// on a cold, restarted, or idle broker fails with "Peer not found".

test("a send TO the reserved slack-bridge id works on a cold broker, before anything sent FROM it", async (t) => {
  const { call } = await startBroker(t);
  const { body: reg } = await call("/register", REG);
  const reply = await call("/send-message", { from_id: reg.id, to_id: "slack-bridge", text: "a reply" });
  assert.equal(reply.body.ok, true, `send to reserved id failed: ${reply.body.error}`);
  const { body: taken } = await call("/take-messages", { id: "slack-bridge" });
  assert.deepEqual(taken.messages.map((m) => m.text), ["a reply"]);
});

test("the daemon sender registers as reserved, not the reaped adhoc kind", async (t) => {
  let now = Date.parse("2026-09-17T12:00:00Z");
  const { broker, call } = await startBroker(t, { _now: () => new Date(now) });
  const { body: reg } = await call("/register", REG);
  await call("/send-message", { from_id: "slack-bridge", to_id: reg.id, text: "hello" });
  now += 2 * 60 * 60 * 1000; // past the 1 h ad-hoc reap
  await call("/list-peers", { scope: "machine", cwd: "x", git_root: null, include_adhoc: true }); // triggers reapDead
  const { body: peers } = await call("/list-peers", { scope: "machine", cwd: "x", git_root: null, include_adhoc: true });
  const sb = peers.find((p) => p.id === "slack-bridge");
  assert.ok(sb, "slack-bridge must survive the ad-hoc reap");
  assert.equal(sb.kind, "reserved", `kind must be reserved, got ${sb.kind}`);
  broker.reapDead();
  const { body: after } = await call("/list-peers", { scope: "machine", cwd: "x", git_root: null, include_adhoc: true });
  assert.ok(after.some((p) => p.id === "slack-bridge"), "reserved peer must never be reaped");
  const reply = await call("/send-message", { from_id: reg.id, to_id: "slack-bridge", text: "re: hello" });
  assert.equal(reply.body.ok, true, `reply after idle failed: ${reply.body.error}`);
});

// --- prototype-key guards ---
// state.peers is a bare JSON.parse product, so `state.peers["constructor"]` is
// Object — truthy. The old `!state.peers[body.to_id]` guard therefore let a
// prototype key through the reserved check and queued a message to an id nothing
// polls, reporting ok:true. Object.hasOwn is the fix.

test("a prototype key is not a recipient: send-message refuses instead of queueing into the void", async (t) => {
  const { call } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const r = await call("/send-message", { from_id: a.id, to_id: "constructor", text: "into the void" });
  assert.equal(r.body.ok, false, "a prototype key must not be accepted as a recipient");
  assert.match(r.body.error, /not found/i);
});

test("an unknown prototype-key sender is registered as an own property, not read off the prototype", async (t) => {
  const { call } = await startBroker(t);
  const { body: reg } = await call("/register", REG);
  const send = await call("/send-message", { from_id: "constructor", to_id: reg.id, text: "hi" });
  assert.equal(send.body.ok, true, `send failed: ${send.body.error}`);
  // The registration itself is the point: a bare index reads Object off the prototype,
  // skips the auto-register, and leaves a sender that nothing can reply to.
  const { body: peers } = await call("/list-peers", { scope: "machine", cwd: "x", git_root: null, include_adhoc: true });
  assert.ok(peers.some((p) => p.id === "constructor"), "the prototype-key sender must be registered");
  const reply = await call("/send-message", { from_id: reg.id, to_id: "constructor", text: "re: hi" });
  assert.equal(reply.body.ok, true, `reply to the prototype-key sender failed: ${reply.body.error}`);
  assert.equal((await call("/take-messages", { id: "constructor" })).body.messages[0].text, "re: hi");
});

test("an unknown non-reserved recipient is still rejected — the reserved branch is not an open door", async (t) => {
  const { call } = await startBroker(t);
  const { body: reg } = await call("/register", REG);
  const r = await call("/send-message", { from_id: reg.id, to_id: "no-such-peer", text: "x" });
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /not found/);
});

test("the reserved peer cannot be unregistered", async (t) => {
  const { call } = await startBroker(t);
  const { body: reg } = await call("/register", REG);
  await call("/send-message", { from_id: reg.id, to_id: "slack-bridge", text: "materialise" });
  const r = await call("/unregister", { id: "slack-bridge" });
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /reserved/);
});

// --- token guard (mirrors the control endpoint) ---

test("with a token set, POST routes without a Bearer header get 401", async (t) => {
  const { port } = await startBroker(t, { token: "sekrit" });
  const res = await fetch(`http://127.0.0.1:${port}/send-message`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from_id: "s1", to_id: "slack-bridge", text: "x" }),
  });
  assert.equal(res.status, 401);
});

test("with a token set, a correct Bearer header is accepted and /health stays open", async (t) => {
  const { port } = await startBroker(t, { token: "sekrit" });
  const res = await fetch(`http://127.0.0.1:${port}/send-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sekrit" },
    body: JSON.stringify({ from_id: "s1", to_id: "slack-bridge", text: "x" }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200, "/health must stay open for liveness probes");
});

// --- /wait: the long-poll the background waiter drives ---
// Take semantics, same consumer contract as check_messages. One consumer per
// message, always: two open waiters for one peer must never both be handed it.

test("a queued message is returned by /wait at once and is gone from take-messages", async (t) => {
  const { call } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "already here" });
  const { body: waited } = await call("/wait", { id: b.id, timeout_ms: 5000 });
  assert.deepEqual(waited.messages.map((m) => m.text), ["already here"]);
  const { body: taken } = await call("/take-messages", { id: b.id });
  assert.equal(taken.messages.length, 0, "the take must have removed it");
});

test("/wait resolves on a later send, well before timeout_ms", async (t) => {
  const { call } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  const pending = call("/wait", { id: b.id, timeout_ms: 5000 });
  await sleep(50);
  const t0 = Date.now();
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "wake" });
  const { body: waited } = await pending;
  assert.deepEqual(waited.messages.map((m) => m.text), ["wake"]);
  assert.ok(Date.now() - t0 < 2000, "must resolve on the send, not by running out the window");
});

test("/wait with nothing sent resolves {messages: []} at timeout_ms", async (t) => {
  const { call } = await startBroker(t);
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  const t0 = Date.now();
  const { body: waited } = await call("/wait", { id: b.id, timeout_ms: 150 });
  const elapsed = Date.now() - t0;
  assert.deepEqual(waited.messages, []);
  assert.ok(elapsed >= 120, `must hold the window, returned after ${elapsed}ms`);
});

test("two open waiters for one peer, one send: exactly one receives it", async (t) => {
  const { call } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  const w1 = call("/wait", { id: b.id, timeout_ms: 5000 });
  const w2 = call("/wait", { id: b.id, timeout_ms: 400 });
  await sleep(50);
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "one copy only" });
  const results = await Promise.all([w1, w2]);
  const nonEmpty = results.filter((r) => r.body.messages.length > 0);
  assert.equal(nonEmpty.length, 1, "exactly one waiter may be handed the message");
  assert.equal(nonEmpty[0].body.messages[0].text, "one copy only");
});

// A1: `req.on("close")` fires as soon as the request body is consumed, so
// dropping the waiter there would empty every long-poll that outlives its body.
// The waiter must survive the whole window on a connected socket.
test("a long-poll that runs to its window stays registered; a send near the end is delivered through it (A1)", async (t) => {
  const { call } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  const timeout = 1500;
  const pending = call("/wait", { id: b.id, timeout_ms: timeout });
  await sleep(timeout - 400);
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "late but delivered" });
  const { body: waited } = await pending;
  assert.deepEqual(waited.messages.map((m) => m.text), ["late but delivered"],
    "the waiter must still be registered at timeout_ms - 400");
});

test("a client that disconnects mid-wait drops its waiter; a following send stays queued", async (t) => {
  const { port, call, armed } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  const ac = new AbortController();
  const pending = fetch(`http://127.0.0.1:${port}/wait`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: b.id, timeout_ms: 5000 }), signal: ac.signal,
  }).catch(() => {});
  await sleep(50);
  ac.abort();
  await pending;
  await sleep(50);
  assert.equal(await armed(b.id), false, "a dropped waiter must not read as armed");
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "still mine" });
  const { body: taken } = await call("/take-messages", { id: b.id });
  assert.deepEqual(taken.messages.map((m) => m.text), ["still mine"],
    "the dropped waiter must not have consumed the message");
});

test("armed is true while a wait is open, true inside the 5 s grace, false after it", async (t) => {
  let now = 1_000_000;
  const { call, armed } = await startBroker(t, { _now: () => new Date(now) });
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  const pending = call("/wait", { id: b.id, timeout_ms: 5000 });
  await sleep(50);
  assert.equal(await armed(b.id), true, "armed while the wait is open");
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "x" });
  await pending;
  assert.equal(await armed(b.id), true, "armed inside the 5 s grace after the window resolves");
  now += 6000;
  assert.equal(await armed(b.id), false, "unarmed past the grace");
});

// A2: the injected _now returns a Date, so `now + 5000` is string concatenation
// and the comparison against epoch ms is never true — armed would be permanently
// false and the Stop hook would nudge a session that is already waiting.
test("armed against a Date-returning _now is a real boolean, true in the grace window (A2)", async (t) => {
  const now = Date.parse("2026-09-17T12:00:00Z");
  const { call, armed } = await startBroker(t, { _now: () => new Date(now) });
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  const pending = call("/wait", { id: b.id, timeout_ms: 300 });
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "x" });
  await pending;
  const value = await armed(b.id);
  assert.equal(typeof value, "boolean", "armed must be a boolean, not a coerced string compare");
  assert.equal(value, true, "must be armed inside the grace window");
});

test("/register stores session_id and /list-peers exposes it", async (t) => {
  const { call } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid, session_id: "sess-abc" });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  const { body: peers } = await call("/list-peers", { scope: "machine", cwd: "x", git_root: null });
  assert.equal(peers.find((p) => p.id === a.id).session_id, "sess-abc");
  assert.equal(peers.find((p) => p.id === b.id).session_id, null, "absent session_id must read as null");
});

test("a sent message carries kind; only kind 'status' is treated as a status", async (t) => {
  const { call } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "plain" });
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "Read: a.mjs", kind: "status" });
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "mislabelled", kind: "banana" });
  const { body: taken } = await call("/take-messages", { id: b.id });
  assert.deepEqual(taken.messages.map((m) => m.kind), ["text", "status", "text"]);
});

test("kind survives a round-trip through /wait", async (t) => {
  const { call } = await startBroker(t);
  const { body: a } = await call("/register", { ...REG, pid: process.pid });
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  await call("/send-message", { from_id: a.id, to_id: b.id, text: "Bash: ls", kind: "status" });
  const { body: waited } = await call("/wait", { id: b.id, timeout_ms: 1000 });
  assert.equal(waited.messages[0].kind, "status");
});

// A7: the push path is gone with the channel notification. Two delivery
// semantics for one direction is what /take-messages + /wait would have had to
// reconcile, so the route is deleted outright rather than left as a third.
test("/poll-messages is gone (A7)", async (t) => {
  const { call } = await startBroker(t);
  const { body: b } = await call("/register", { ...REG, pid: process.ppid });
  const r = await call("/poll-messages", { id: b.id });
  assert.equal(r.status, 404);
});

// Pin, already held by the fork's reap: re-registration purges the old id's
// undelivered queue like a death does — otherwise messages to the old id leak.
test("re-register purges the old id and its undelivered messages from state", async (t) => {
  const stateFile = tmpState();
  const broker = createBroker({ stateFile });
  t.after(() => broker.close());
  const port = await broker.listen(0);
  const call = async (p, body) =>
    (await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", body: JSON.stringify(body) })).json();
  const a = await call("/register", { ...REG, pid: process.pid });
  const b = await call("/register", { ...REG, pid: process.ppid });
  await call("/send-message", { from_id: b.id, to_id: a.id, text: "queued for old id" });
  await call("/register", { ...REG, pid: process.pid }); // a re-registers
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.messages.filter((m) => m.to_id === a.id).length, 0,
    "undelivered messages to the replaced id must be purged");
});
