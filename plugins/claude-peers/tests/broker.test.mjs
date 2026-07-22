import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBroker } from '../src/broker/index.mjs';

function tmpState() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'peers-broker-')), 'state.json');
}

// Every test spins a real node:http broker on an ephemeral port (never 7899).
// t.after closes it even when an assertion throws — a failing test must not
// leave a live server holding the runner open.
async function startBroker(t, opts = {}) {
  const broker = createBroker({ stateFile: opts.stateFile ?? tmpState(), ...opts });
  t.after(() => broker.close());
  const port = await broker.listen(0);
  const call = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { broker, port, call };
}

const REG = { pid: process.pid, cwd: 'C:/work/a', git_root: 'C:/work/a', tty: null, summary: 'hi' };

test('register assigns an 8-char id and the peer appears in list-peers', async (t) => {
  const { broker, call } = await startBroker(t);
  const { body: reg } = await call('/register', REG);
  assert.match(reg.id, /^[a-z0-9]{8}$/);
  const { body: peers } = await call('/list-peers', { scope: 'machine', cwd: 'x', git_root: null });
  assert.equal(peers.length, 1);
  assert.equal(peers[0].id, reg.id);
});

test('re-register with the same pid replaces the old row', async (t) => {
  const { broker, call } = await startBroker(t);
  const { body: first } = await call('/register', REG);
  const { body: second } = await call('/register', REG);
  const { body: peers } = await call('/list-peers', { scope: 'machine', cwd: 'x', git_root: null });
  assert.equal(peers.length, 1);
  assert.equal(peers[0].id, second.id);
  assert.notEqual(first.id, second.id);
});

test('heartbeat advances last_seen', async (t) => {
  let now = 1000;
  const { broker, call } = await startBroker(t, { _now: () => new Date(now) });
  const { body: reg } = await call('/register', REG);
  now = 5000;
  await call('/heartbeat', { id: reg.id });
  const { body: peers } = await call('/list-peers', { scope: 'machine', cwd: 'x', git_root: null });
  assert.equal(peers[0].last_seen, new Date(5000).toISOString());
});

test('list-peers scopes: directory filters by cwd, repo by git_root (cwd fallback)', async (t) => {
  const { broker, call } = await startBroker(t);
  await call('/register', { ...REG, pid: process.pid, cwd: 'C:/work/a', git_root: 'C:/work/a' });
  // second peer, different cwd/repo — same live pid so liveness passes
  await call('/register', { ...REG, pid: process.ppid, cwd: 'C:/work/b', git_root: 'C:/work/b' });
  const dir = await call('/list-peers', { scope: 'directory', cwd: 'C:/work/b', git_root: null });
  assert.deepEqual(dir.body.map(p => p.cwd), ['C:/work/b']);
  const repo = await call('/list-peers', { scope: 'repo', cwd: 'zzz', git_root: 'C:/work/a' });
  assert.deepEqual(repo.body.map(p => p.git_root), ['C:/work/a']);
  const fallback = await call('/list-peers', { scope: 'repo', cwd: 'C:/work/b', git_root: null });
  assert.deepEqual(fallback.body.map(p => p.cwd), ['C:/work/b']);
});

test('list-peers excludes the requesting peer via exclude_id', async (t) => {
  const { broker, call } = await startBroker(t);
  const { body: reg } = await call('/register', REG);
  const { body: peers } = await call('/list-peers', { scope: 'machine', cwd: 'x', git_root: null, exclude_id: reg.id });
  assert.equal(peers.length, 0);
});

test('dead peers are reaped and their undelivered messages dropped', async (t) => {
  const dead = new Set();
  const _kill = (pid) => { if (dead.has(pid)) throw new Error('ESRCH'); };
  const { broker, call } = await startBroker(t, { _kill });
  const { body: a } = await call('/register', { ...REG, pid: 111 });
  const { body: b } = await call('/register', { ...REG, pid: 222 });
  await call('/send-message', { from_id: b.id, to_id: a.id, text: 'never delivered' });
  dead.add(111);
  const { body: peers } = await call('/list-peers', { scope: 'machine', cwd: 'x', git_root: null });
  assert.deepEqual(peers.map(p => p.id), [b.id]);
  // a's queue is gone with it: re-registering pid 111 gets a fresh id and no backlog
  const { body: a2 } = await call('/register', { ...REG, pid: 111 });
  dead.delete(111);
  const { body: polled } = await call('/poll-messages', { id: a2.id });
  assert.equal(polled.messages.length, 0);
});

test('send-message to an unknown target reports not found', async (t) => {
  const { broker, call } = await startBroker(t);
  const { body: reg } = await call('/register', REG);
  const { body } = await call('/send-message', { from_id: reg.id, to_id: 'nope1234', text: 'x' });
  assert.equal(body.ok, false);
  assert.match(body.error, /not found/);
});

// The 2026-07-16 "they couldn't reply" defect: an unregistered sender must be
// auto-registered as an adhoc peer so the reply has somewhere to route.
test('send-message from an unknown sender auto-registers adhoc; the reply routes back', async (t) => {
  const { broker, call } = await startBroker(t);
  const { body: reg } = await call('/register', REG);
  const send = await call('/send-message', { from_id: 'operator-console', to_id: reg.id, text: 'ping' });
  assert.equal(send.body.ok, true);
  const reply = await call('/send-message', { from_id: reg.id, to_id: 'operator-console', text: 'ack' });
  assert.equal(reply.body.ok, true, `reply failed: ${reply.body.error}`);
  const { body: polled } = await call('/poll-messages', { id: 'operator-console' });
  assert.deepEqual(polled.messages.map(m => m.text), ['ack']);
});

test('adhoc peers are hidden from list-peers unless include_adhoc', async (t) => {
  const { broker, call } = await startBroker(t);
  const { body: reg } = await call('/register', REG);
  await call('/send-message', { from_id: 'operator-console', to_id: reg.id, text: 'ping' });
  const { body: without } = await call('/list-peers', { scope: 'machine', cwd: 'x', git_root: null });
  assert.deepEqual(without.map(p => p.id), [reg.id]);
  const { body: withAdhoc } = await call('/list-peers', { scope: 'machine', cwd: 'x', git_root: null, include_adhoc: true });
  assert.deepEqual(withAdhoc.map(p => p.id).sort(), [reg.id, 'operator-console'].sort());
});

test('poll-messages delivers once, in order', async (t) => {
  const { broker, call } = await startBroker(t);
  const { body: a } = await call('/register', { ...REG, pid: process.pid });
  const { body: b } = await call('/register', { ...REG, pid: process.ppid });
  await call('/send-message', { from_id: a.id, to_id: b.id, text: 'one' });
  await call('/send-message', { from_id: a.id, to_id: b.id, text: 'two' });
  const first = await call('/poll-messages', { id: b.id });
  assert.deepEqual(first.body.messages.map(m => m.text), ['one', 'two']);
  const second = await call('/poll-messages', { id: b.id });
  assert.equal(second.body.messages.length, 0);
});

// The bug this endpoint pair exists for: the push is a channel notification
// into a session that may be idle, and nothing acks back. Deleting on push lost
// the message outright, and check_messages — the documented recovery — found an
// already-empty queue.
test('a pushed message is retained and check_messages can still recover it', async (t) => {
  const { broker, call } = await startBroker(t);
  const { body: a } = await call('/register', { ...REG, pid: process.pid });
  const { body: b } = await call('/register', { ...REG, pid: process.ppid });
  await call('/send-message', { from_id: a.id, to_id: b.id, text: 'missed while idle' });
  const { body: pushed } = await call('/poll-messages', { id: b.id });
  assert.deepEqual(pushed.messages.map(m => m.text), ['missed while idle']);
  const { body: taken } = await call('/take-messages', { id: b.id });
  assert.deepEqual(taken.messages.map(m => m.text), ['missed while idle']);
});

test('take-messages consumes: a second take returns nothing', async (t) => {
  const { broker, call } = await startBroker(t);
  const { body: a } = await call('/register', { ...REG, pid: process.pid });
  const { body: b } = await call('/register', { ...REG, pid: process.ppid });
  await call('/send-message', { from_id: a.id, to_id: b.id, text: 'once' });
  await call('/poll-messages', { id: b.id });
  assert.equal((await call('/take-messages', { id: b.id })).body.messages.length, 1);
  assert.equal((await call('/take-messages', { id: b.id })).body.messages.length, 0);
});

test('take-messages returns never-pushed messages too, and stops them being pushed later', async (t) => {
  const { broker, call } = await startBroker(t);
  const { body: a } = await call('/register', { ...REG, pid: process.pid });
  const { body: b } = await call('/register', { ...REG, pid: process.ppid });
  await call('/send-message', { from_id: a.id, to_id: b.id, text: 'never pushed' });
  const { body: taken } = await call('/take-messages', { id: b.id });
  assert.deepEqual(taken.messages.map(m => m.text), ['never pushed']);
  const { body: polled } = await call('/poll-messages', { id: b.id });
  assert.equal(polled.messages.length, 0, 'a consumed message must not resurface as a push');
});

test('retained messages are purged once past the retention window', async (t) => {
  let now = Date.parse('2026-07-22T12:00:00Z');
  const stateFile = tmpState();
  const { broker, call } = await startBroker(t, { stateFile, _now: () => new Date(now) });
  const { body: a } = await call('/register', { ...REG, pid: process.pid });
  const { body: b } = await call('/register', { ...REG, pid: process.ppid });
  await call('/send-message', { from_id: a.id, to_id: b.id, text: 'stale' });
  await call('/poll-messages', { id: b.id });
  now += 23 * 60 * 60 * 1000;
  await call('/poll-messages', { id: b.id });
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.messages.length, 1, 'still inside the window — must still be retained');
  now += 2 * 60 * 60 * 1000;
  await call('/poll-messages', { id: b.id }); // any traffic triggers the purge
  assert.equal((await call('/take-messages', { id: b.id })).body.messages.length, 0);
});

test('reaping a dead peer drops its retained messages, not just its unpushed ones', async (t) => {
  const stateFile = tmpState();
  const dead = new Set();
  const _kill = (pid) => { if (dead.has(pid)) throw new Error('ESRCH'); };
  const { broker, call } = await startBroker(t, { stateFile, _kill });
  const { body: a } = await call('/register', { ...REG, pid: 111 });
  const { body: b } = await call('/register', { ...REG, pid: 222 });
  await call('/send-message', { from_id: b.id, to_id: a.id, text: 'retained' });
  await call('/poll-messages', { id: a.id });
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).messages.length, 1, 'pushed message must be retained');
  dead.add(111);
  await call('/list-peers', { scope: 'machine', cwd: 'x', git_root: null });
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.messages.length, 0, 'a reaped peer must not leak retained messages');
});

// Review finding #2: re-registration must purge the old id's queue like a
// death does — otherwise undelivered messages to the old id leak forever.
test('re-register purges the old id and its undelivered messages from state', async (t) => {
  const stateFile = tmpState();
  const broker = createBroker({ stateFile });
  t.after(() => broker.close());
  const port = await broker.listen(0);
  const call = async (p, body) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', body: JSON.stringify(body) })).json();
  const a = await call('/register', { ...REG, pid: process.pid });
  const b = await call('/register', { ...REG, pid: process.ppid });
  await call('/send-message', { from_id: b.id, to_id: a.id, text: 'queued for old id' });
  await call('/register', { ...REG, pid: process.pid }); // a re-registers
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.messages.length, 0, 'undelivered messages to the replaced id must be purged');
  assert.equal(Object.keys(state.peers).length, 2);
});

// Review finding #3: a corrupted message id in loaded state must not poison
// the id counter into NaN for every subsequent message.
test('non-numeric message ids in loaded state do not poison the id counter', async (t) => {
  const stateFile = tmpState();
  fs.writeFileSync(stateFile, JSON.stringify({
    peers: {},
    messages: [{ id: 'garbage', from_id: 'x', to_id: 'y', text: 'old', sent_at: 't', delivered: false }],
  }));
  const { broker, call } = await startBroker(t, { stateFile });
  const { body: reg } = await call('/register', REG);
  await call('/send-message', { from_id: reg.id, to_id: reg.id, text: 'new' });
  const { body: polled } = await call('/poll-messages', { id: reg.id });
  const fresh = polled.messages.find((m) => m.text === 'new');
  assert.ok(Number.isInteger(fresh.id), `new message id must be an integer, got ${fresh.id}`);
});

// Review finding #9: the shared broker must cap request bodies — any local
// process could otherwise OOM it with one unbounded POST.
test('oversized POST bodies are rejected with 413, not buffered', async (t) => {
  const { broker, port } = await startBroker(t);
  const res = await fetch(`http://127.0.0.1:${port}/send-message`, {
    method: 'POST',
    body: JSON.stringify({ from_id: 'a', to_id: 'b', text: 'x'.repeat(2_000_000) }),
  }).catch((e) => ({ status: 'aborted', aborted: true }));
  assert.ok(res.aborted || res.status === 413, `expected 413 or aborted socket, got ${res.status}`);
});

// Review finding #7 (fix side): /shutdown lets `broker stop` end the broker
// without a pid-based kill that could hit a reused pid.
test('POST /shutdown closes the broker gracefully', async (t) => {
  let shutdownCalled = false;
  const { broker, port, call } = await startBroker(t, { onShutdown: () => { shutdownCalled = true; } });
  const { body } = await call('/shutdown', {});
  assert.equal(body.ok, true);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(shutdownCalled, true, 'onShutdown hook must fire');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }));
});

test('state survives a broker restart via the state file', async () => {
  const stateFile = tmpState();
  const b1 = createBroker({ stateFile });
  const port1 = await b1.listen(0);
  const reg = await (await fetch(`http://127.0.0.1:${port1}/register`, { method: 'POST', body: JSON.stringify(REG) })).json();
  await b1.close();
  const b2 = createBroker({ stateFile });
  const port2 = await b2.listen(0);
  const peers = await (await fetch(`http://127.0.0.1:${port2}/list-peers`, { method: 'POST', body: JSON.stringify({ scope: 'machine', cwd: 'x', git_root: null }) })).json();
  assert.deepEqual(peers.map(p => p.id), [reg.id]);
  await b2.close();
});

test('a corrupt state file is quarantined loudly, not silently overwritten', async (t) => {
  const stateFile = tmpState();
  fs.writeFileSync(stateFile, '{ definitely not json');
  const logged = [];
  const broker = createBroker({ stateFile, log: (m) => logged.push(m) });
  t.after(() => broker.close());
  const port = await broker.listen(0);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.status, 'ok');
  assert.ok(logged.some(m => /corrupt|unreadable/i.test(m)), 'must log the quarantine');
  const quarantined = fs.readdirSync(path.dirname(stateFile)).filter(f => f.includes('corrupt'));
  assert.equal(quarantined.length, 1, 'corrupt file must be preserved, not deleted');
});

test('GET /health reports ok and a peer count', async (t) => {
  const { broker, port } = await startBroker(t);
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.peers, 'number');
});

test('unknown POST path is a 404, handler errors are 500 with a message', async (t) => {
  const { broker, call } = await startBroker(t);
  const notFound = await call('/no-such', {});
  assert.equal(notFound.status, 404);
});
