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
async function startBroker(opts = {}) {
  const broker = createBroker({ stateFile: tmpState(), ...opts });
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

test('register assigns an 8-char id and the peer appears in list-peers', async () => {
  const { broker, call } = await startBroker();
  const { body: reg } = await call('/register', REG);
  assert.match(reg.id, /^[a-z0-9]{8}$/);
  const { body: peers } = await call('/list-peers', { scope: 'machine', cwd: 'x', git_root: null });
  assert.equal(peers.length, 1);
  assert.equal(peers[0].id, reg.id);
  await broker.close();
});

test('re-register with the same pid replaces the old row', async () => {
  const { broker, call } = await startBroker();
  const { body: first } = await call('/register', REG);
  const { body: second } = await call('/register', REG);
  const { body: peers } = await call('/list-peers', { scope: 'machine', cwd: 'x', git_root: null });
  assert.equal(peers.length, 1);
  assert.equal(peers[0].id, second.id);
  assert.notEqual(first.id, second.id);
  await broker.close();
});

test('heartbeat advances last_seen', async () => {
  let t = 1000;
  const { broker, call } = await startBroker({ _now: () => new Date(t) });
  const { body: reg } = await call('/register', REG);
  t = 5000;
  await call('/heartbeat', { id: reg.id });
  const { body: peers } = await call('/list-peers', { scope: 'machine', cwd: 'x', git_root: null });
  assert.equal(peers[0].last_seen, new Date(5000).toISOString());
  await broker.close();
});

test('list-peers scopes: directory filters by cwd, repo by git_root (cwd fallback)', async () => {
  const { broker, call } = await startBroker();
  await call('/register', { ...REG, pid: process.pid, cwd: 'C:/work/a', git_root: 'C:/work/a' });
  // second peer, different cwd/repo — same live pid so liveness passes
  await call('/register', { ...REG, pid: process.ppid, cwd: 'C:/work/b', git_root: 'C:/work/b' });
  const dir = await call('/list-peers', { scope: 'directory', cwd: 'C:/work/b', git_root: null });
  assert.deepEqual(dir.body.map(p => p.cwd), ['C:/work/b']);
  const repo = await call('/list-peers', { scope: 'repo', cwd: 'zzz', git_root: 'C:/work/a' });
  assert.deepEqual(repo.body.map(p => p.git_root), ['C:/work/a']);
  const fallback = await call('/list-peers', { scope: 'repo', cwd: 'C:/work/b', git_root: null });
  assert.deepEqual(fallback.body.map(p => p.cwd), ['C:/work/b']);
  await broker.close();
});

test('list-peers excludes the requesting peer via exclude_id', async () => {
  const { broker, call } = await startBroker();
  const { body: reg } = await call('/register', REG);
  const { body: peers } = await call('/list-peers', { scope: 'machine', cwd: 'x', git_root: null, exclude_id: reg.id });
  assert.equal(peers.length, 0);
  await broker.close();
});

test('dead peers are reaped and their undelivered messages dropped', async () => {
  const dead = new Set();
  const _kill = (pid) => { if (dead.has(pid)) throw new Error('ESRCH'); };
  const { broker, call } = await startBroker({ _kill });
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
  await broker.close();
});

test('send-message to an unknown target reports not found', async () => {
  const { broker, call } = await startBroker();
  const { body: reg } = await call('/register', REG);
  const { body } = await call('/send-message', { from_id: reg.id, to_id: 'nope1234', text: 'x' });
  assert.equal(body.ok, false);
  assert.match(body.error, /not found/);
  await broker.close();
});

// The 2026-07-16 "they couldn't reply" defect: an unregistered sender must be
// auto-registered as an adhoc peer so the reply has somewhere to route.
test('send-message from an unknown sender auto-registers adhoc; the reply routes back', async () => {
  const { broker, call } = await startBroker();
  const { body: reg } = await call('/register', REG);
  const send = await call('/send-message', { from_id: 'operator-console', to_id: reg.id, text: 'ping' });
  assert.equal(send.body.ok, true);
  const reply = await call('/send-message', { from_id: reg.id, to_id: 'operator-console', text: 'ack' });
  assert.equal(reply.body.ok, true, `reply failed: ${reply.body.error}`);
  const { body: polled } = await call('/poll-messages', { id: 'operator-console' });
  assert.deepEqual(polled.messages.map(m => m.text), ['ack']);
  await broker.close();
});

test('adhoc peers are hidden from list-peers unless include_adhoc', async () => {
  const { broker, call } = await startBroker();
  const { body: reg } = await call('/register', REG);
  await call('/send-message', { from_id: 'operator-console', to_id: reg.id, text: 'ping' });
  const { body: without } = await call('/list-peers', { scope: 'machine', cwd: 'x', git_root: null });
  assert.deepEqual(without.map(p => p.id), [reg.id]);
  const { body: withAdhoc } = await call('/list-peers', { scope: 'machine', cwd: 'x', git_root: null, include_adhoc: true });
  assert.deepEqual(withAdhoc.map(p => p.id).sort(), [reg.id, 'operator-console'].sort());
  await broker.close();
});

test('poll-messages delivers once, in order', async () => {
  const { broker, call } = await startBroker();
  const { body: a } = await call('/register', { ...REG, pid: process.pid });
  const { body: b } = await call('/register', { ...REG, pid: process.ppid });
  await call('/send-message', { from_id: a.id, to_id: b.id, text: 'one' });
  await call('/send-message', { from_id: a.id, to_id: b.id, text: 'two' });
  const first = await call('/poll-messages', { id: b.id });
  assert.deepEqual(first.body.messages.map(m => m.text), ['one', 'two']);
  const second = await call('/poll-messages', { id: b.id });
  assert.equal(second.body.messages.length, 0);
  await broker.close();
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

test('a corrupt state file is quarantined loudly, not silently overwritten', async () => {
  const stateFile = tmpState();
  fs.writeFileSync(stateFile, '{ definitely not json');
  const logged = [];
  const broker = createBroker({ stateFile, log: (m) => logged.push(m) });
  const port = await broker.listen(0);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.status, 'ok');
  assert.ok(logged.some(m => /corrupt|unreadable/i.test(m)), 'must log the quarantine');
  const quarantined = fs.readdirSync(path.dirname(stateFile)).filter(f => f.includes('corrupt'));
  assert.equal(quarantined.length, 1, 'corrupt file must be preserved, not deleted');
  await broker.close();
});

test('GET /health reports ok and a peer count', async () => {
  const { broker, port } = await startBroker();
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.peers, 'number');
  await broker.close();
});

test('unknown POST path is a 404, handler errors are 500 with a message', async () => {
  const { broker, call } = await startBroker();
  const notFound = await call('/no-such', {});
  assert.equal(notFound.status, 404);
  await broker.close();
});
