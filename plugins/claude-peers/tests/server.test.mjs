import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createPeersServer, TOOLS } from '../src/mcp/server.mjs';

const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/initialize.json', import.meta.url), 'utf8'));
const CONFIG = { port: 65001, pollIntervalMs: 1000, heartbeatIntervalMs: 15000 };

function okJson(value) {
  return { ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) };
}

function makeServer({ fetchImpl, spawnCalls = [], onSpawn } = {}) {
  const output = new PassThrough();
  const written = [];
  output.on('data', (c) => written.push(c.toString()));
  const _spawn = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args, opts });
    onSpawn?.();
    return { unref: () => {}, pid: 99999 };
  };
  const server = createPeersServer({
    config: CONFIG,
    input: new PassThrough(),
    output,
    _fetch: fetchImpl ?? (async () => okJson({})),
    _spawn,
    _pid: 4242,
    _cwd: 'C:/work/repo',
  });
  const notifications = () => written.join('').split('\n').filter(Boolean).map(JSON.parse);
  return { server, notifications, spawnCalls };
}

// --- handshake ---

test('initialize response matches the fixture captured from the live upstream server', async () => {
  const { server } = makeServer();
  const result = await server._onRequest('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0.0.0' } });
  const expected = FIXTURE.result;
  assert.equal(result.protocolVersion, expected.protocolVersion);
  assert.deepEqual(result.capabilities, expected.capabilities);
  assert.equal(result.serverInfo.name, expected.serverInfo.name);
  assert.equal(result.instructions, expected.instructions);
});

// Review finding #5: never echo an arbitrary client protocolVersion — we
// implement 2024-11-05 semantics and must say so when asked for anything else.
test('initialize with an unsupported protocolVersion responds with the version we implement', async () => {
  const { server } = makeServer();
  const result = await server._onRequest('initialize', { protocolVersion: '2099-12-31', capabilities: {}, clientInfo: { name: 'probe', version: '0' } });
  assert.equal(result.protocolVersion, '2024-11-05');
});

// Review finding #8: concurrent broker-call failures must share ONE respawn —
// no thundering herd of spawns when several calls fail at once.
test('concurrent connection failures share a single ensureBroker respawn', async () => {
  // health stays dead until a spawn "starts the broker" ~300ms later — every
  // caller that checks health before then sees it down, exposing spawn storms.
  let broken = true;
  const fetchImpl = async (url) => {
    if (broken) throw new TypeError('fetch failed');
    return okJson(String(url).endsWith('/health') ? { status: 'ok' } : { fine: true });
  };
  const { server, spawnCalls } = makeServer({
    fetchImpl,
    onSpawn: () => setTimeout(() => { broken = false; }, 300),
  });
  const results = await Promise.all([
    server._brokerFetch('/heartbeat', { id: 'x' }),
    server._brokerFetch('/poll-messages', { id: 'x' }),
    server._brokerFetch('/set-summary', { id: 'x' }),
  ]);
  assert.equal(results.length, 3);
  assert.equal(spawnCalls.length, 1, `expected exactly one spawn, got ${spawnCalls.length}`);
});

test('tools/list returns the four upstream tools with identical names and required fields', async () => {
  const { server } = makeServer();
  const { tools } = await server._onRequest('tools/list', {});
  assert.deepEqual(tools.map(t => t.name), ['list_peers', 'send_message', 'set_summary', 'check_messages']);
  assert.deepEqual(tools[0].inputSchema.required, ['scope']);
  assert.deepEqual(tools[1].inputSchema.required, ['to_id', 'message']);
  assert.equal(tools, TOOLS);
});

test('unknown rpc method throws with rpcCode -32601', async () => {
  const { server } = makeServer();
  await assert.rejects(server._onRequest('bogus/method', {}), (e) => e.rpcCode === -32601);
});

// --- tools ---

test('list_peers renders peers as upstream-shaped text content', async () => {
  const peers = [{ id: 'aa11bb22', pid: 1, cwd: 'C:/x', git_root: 'C:/x', tty: null, summary: 'doing y', registered_at: 't', last_seen: 't' }];
  const { server } = makeServer({ fetchImpl: async (url) => okJson(String(url).endsWith('/list-peers') ? peers : {}) });
  const res = await server._onRequest('tools/call', { name: 'list_peers', arguments: { scope: 'machine' } });
  assert.equal(res.content[0].type, 'text');
  assert.match(res.content[0].text, /Found 1 peer\(s\) \(scope: machine\)/);
  assert.match(res.content[0].text, /ID: aa11bb22/);
  assert.match(res.content[0].text, /Summary: doing y/);
});

test('send_message before registration is an isError result, not a throw', async () => {
  const { server } = makeServer();
  const res = await server._onRequest('tools/call', { name: 'send_message', arguments: { to_id: 'x', message: 'hi' } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Not registered/);
});

test('check_messages with no messages says so', async () => {
  const { server } = makeServer({ fetchImpl: async (url) => okJson(String(url).endsWith('/register') ? { id: 'me000001' } : { messages: [] }) });
  await server._register();
  const res = await server._onRequest('tools/call', { name: 'check_messages', arguments: {} });
  assert.equal(res.content[0].text, 'No new messages.');
});

// --- the channel push: verbatim upstream notification shape ---

test('poll pushes inbound messages as notifications/claude/channel with the exact meta shape', async () => {
  const sender = { id: 'sender01', pid: 2, cwd: 'C:/their/dir', git_root: null, tty: null, summary: 'their work', registered_at: 't', last_seen: 't' };
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith('/register')) return okJson({ id: 'me000001' });
    if (u.endsWith('/poll-messages')) return okJson({ messages: [{ id: 1, from_id: 'sender01', to_id: 'me000001', text: 'hello there', sent_at: '2026-07-16T12:00:00Z', delivered: false }] });
    if (u.endsWith('/list-peers')) return okJson([sender]);
    return okJson({});
  };
  const { server, notifications } = makeServer({ fetchImpl });
  await server._register();
  await server._poll();
  const notes = notifications().filter(n => n.method === 'notifications/claude/channel');
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0].params, {
    content: 'hello there',
    meta: { from_id: 'sender01', from_summary: 'their work', from_cwd: 'C:/their/dir', sent_at: '2026-07-16T12:00:00Z' },
  });
});

// --- hardening pins ---

// Pin: mid-session broker death self-heals — connection failure triggers
// ensureBroker (respawn) and exactly one retry.
test('brokerFetch retries once through ensureBroker on connection failure', async () => {
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/health')) return okJson({ status: 'ok' });
    calls++;
    if (calls === 1) { const e = new TypeError('fetch failed'); throw e; }
    return okJson({ echoed: true });
  };
  const { server, spawnCalls } = makeServer({ fetchImpl });
  const result = await server._brokerFetch('/heartbeat', { id: 'x' });
  assert.deepEqual(result, { echoed: true });
  assert.equal(calls, 2);
  assert.equal(spawnCalls.length, 0, 'health said alive — no spawn needed');
});

// Pin: the broker is spawned DETACHED so it survives the spawning session
// (the upstream defect that chained broker lifetime to a random session's job).
test('ensureBroker spawns the broker detached with stdio ignored and windowsHide', async () => {
  let healthy = false;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/health')) {
      if (!healthy) { healthy = true; throw new TypeError('fetch failed'); }
      return okJson({ status: 'ok' });
    }
    return okJson({});
  };
  const { server, spawnCalls } = makeServer({ fetchImpl });
  await server._ensureBroker();
  assert.equal(spawnCalls.length, 1);
  const { cmd, args, opts } = spawnCalls[0];
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args.slice(-2), ['broker', 'run']);
  assert.equal(opts.detached, true);
  assert.equal(opts.stdio, 'ignore');
  assert.equal(opts.windowsHide, true);
});

// Pin: a broker-level error response (not a connection failure) must NOT trigger respawn.
test('a broker 500 propagates without a respawn attempt', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) });
  const { server, spawnCalls } = makeServer({ fetchImpl });
  await assert.rejects(server._brokerFetch('/heartbeat', { id: 'x' }), /Broker error/);
  assert.equal(spawnCalls.length, 0);
});

// Pin: the HOME bug can never come back — nothing under src/ or bin/ reads process.env.HOME.
test('no source file references process.env.HOME', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith('.mjs') && !p.includes('tests')) {
        if (fs.readFileSync(p, 'utf8').includes('process.env.HOME')) offenders.push(p);
      }
    }
  };
  walk(path.join(root, 'src'));
  walk(path.join(root, 'bin'));
  assert.deepEqual(offenders, []);
});
