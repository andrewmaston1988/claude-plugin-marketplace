import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createPeersServer, TOOLS, INSTRUCTIONS, POLLING_INSTRUCTIONS, wrapAt, summaryNag, SUMMARY_STALE_MS } from '../src/mcp/server.mjs';

const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/initialize.json', import.meta.url), 'utf8'));
const CONFIG = { port: 65001, pollIntervalMs: 1000, heartbeatIntervalMs: 15000 };

function okJson(value) {
  return { ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) };
}

function makeServer({ fetchImpl, spawnCalls = [], onSpawn, channels = true } = {}) {
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
    _detectChannels: () => channels,
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
// A session that cannot render <channel> blocks gets nothing pushed to it, so the
// handshake is the only chance to tell it to poll instead.
test('initialize appends the polling instructions when channels are unavailable', async () => {
  const { server } = makeServer({ channels: false });
  const result = await server._onRequest('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert.equal(result.instructions, `${INSTRUCTIONS}\n\n${POLLING_INSTRUCTIONS}`);
  assert.match(result.instructions, /CronCreate\(cron="\*\/3 \* \* \* \*"/);
  assert.match(result.instructions, /check_messages/);
});

test('initialize omits the polling instructions when channels are available', async () => {
  const { server } = makeServer({ channels: true });
  const result = await server._onRequest('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert.equal(result.instructions.includes('CronCreate'), false);
});

test('channel detection runs once per session, not once per handshake', async () => {
  let calls = 0;
  const server = createPeersServer({
    config: CONFIG,
    input: new PassThrough(),
    output: new PassThrough(),
    _fetch: async () => okJson({}),
    _detectChannels: () => { calls++; return false; },
  });
  await server._onRequest('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  await server._onRequest('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert.equal(calls, 1);
});

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

// cwd is REQUIRED, not optional: the registered cwd is only ever the session's
// launch dir, so a peer that moved into a worktree is invisible unless it says
// so — and an optional field is one an agent forgets.
test('set_summary requires cwd in its schema', async () => {
  const { server } = makeServer();
  const { tools } = await server._onRequest('tools/list', {});
  const setSummary = tools.find(t => t.name === 'set_summary');
  assert.deepEqual(setSummary.inputSchema.required, ['summary', 'cwd']);
  assert.ok(setSummary.inputSchema.properties.cwd);
});

test('set_summary refuses a blank cwd rather than storing a summary without one', async () => {
  const calls = [];
  const { server } = makeServer({
    fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return okJson({ id: 'p1' }); },
  });
  await server._register();
  calls.length = 0;

  for (const bad of [undefined, '', '   ']) {
    const res = await server._onRequest('tools/call', { name: 'set_summary', arguments: { summary: 'working', cwd: bad } });
    assert.equal(res.isError, true, `cwd ${JSON.stringify(bad)} was accepted`);
    assert.match(res.content[0].text, /requires `cwd`/);
  }
  assert.equal(calls.filter(c => c.url.includes('/set-summary')).length, 0, 'a summary was stored without a working dir');
});

test('set_summary sends the reported cwd, leaving repo scoping on the launch repo', async () => {
  const calls = [];
  const { server } = makeServer({
    fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return okJson({ id: 'p1' }); },
  });
  await server._register();

  const res = await server._onRequest('tools/call', {
    name: 'set_summary',
    arguments: { summary: 'porting the nursery stage', cwd: 'C:/code/.worktrees/primordial/nursery-stage' },
  });
  assert.equal(res.isError, undefined);
  const sent = calls.find(c => c.url.includes('/set-summary'));
  assert.equal(sent.body.cwd, 'C:/code/.worktrees/primordial/nursery-stage');
  assert.equal(sent.body.summary, 'porting the nursery stage');
  // git_root is deliberately NOT sent: repo scope must keep grouping a fleet
  // working one repo from separate worktrees, which following the worktree
  // toplevel would break.
  assert.equal('git_root' in sent.body, false);
});

test('wrapAt: wraps on word boundaries at the width, indenting continuations', () => {
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const lines = wrapAt(words, 40, '    ').split('\n');
  assert.ok(lines.length > 1, 'did not wrap');
  assert.equal(lines[0].length <= 40, true, lines[0]);
  for (const l of lines.slice(1)) {
    assert.match(l, /^ {4}/, `continuation not indented: ${JSON.stringify(l)}`);
    assert.equal(l.trimStart().length <= 40, true, l);
  }
  // no word was cut in half
  assert.deepEqual(lines.join('\n').split(/\s+/).filter(Boolean), words.split(' '));
});

test('wrapAt: breaks a single token longer than the width rather than overrunning', () => {
  const long = 'C:/' + 'x'.repeat(200);
  for (const l of wrapAt(long, 40).split('\n')) {
    assert.equal(l.trimStart().length <= 40, true, `overran: ${l.length}`);
  }
});

test('wrapAt: short text and empty input pass through unwrapped', () => {
  assert.equal(wrapAt('short one', 120), 'short one');
  assert.equal(wrapAt('', 120), '');
  assert.equal(wrapAt(undefined, 120), '');
});

test('list_peers wraps a long summary instead of emitting one enormous line', async () => {
  const summary = Array.from({ length: 60 }, (_, i) => `token${i}`).join(' ');
  const { server } = makeServer({
    fetchImpl: async () => okJson([
      { id: 'p1', pid: 1, cwd: 'C:/work/repo', git_root: null, summary, summary_updated_at: '2026-08-23T10:00:00.000Z', last_seen: '2026-08-23T12:00:00.000Z' },
    ]),
  });
  const res = await server._onRequest('tools/call', { name: 'list_peers', arguments: { scope: 'machine' } });
  for (const l of res.content[0].text.split('\n')) {
    assert.equal(l.length <= 130, true, `line too long (${l.length}): ${l.slice(0, 60)}…`);
  }
});

// The peer who can refresh a summary is the one party that never sees its own
// row, so the reminder has to travel back to them on calls they already make.
test('summaryNag: silent while fresh, fires once past the threshold', () => {
  const t0 = 1_000_000;
  assert.equal(summaryNag('working', t0, t0 + SUMMARY_STALE_MS - 1), null);
  const nag = summaryNag('working', t0, t0 + SUMMARY_STALE_MS);
  assert.match(nag, /\[claude-peers\] WARNING/);
  assert.match(nag, /set_summary/);
});

test('summaryNag: says nothing when no summary has been published yet', () => {
  assert.equal(summaryNag('', null, 9_999_999), null);
  assert.equal(summaryNag('', 1000, 9_999_999), null);
  assert.equal(summaryNag('set but unstamped', null, 9_999_999), null);
});

test('summaryNag: reports the age', () => {
  const t0 = 1_000_000;
  assert.match(summaryNag('x', t0, t0 + 20 * 60_000), /20m stale/);
  assert.match(summaryNag('x', t0, t0 + 252 * 60_000), /4h12m stale/);
});

test('send_message appends the nag once the sender own summary is stale', async () => {
  let now = 1_000_000;
  const server = createPeersServer({
    config: CONFIG, input: new PassThrough(), output: new PassThrough(),
    _fetch: async () => okJson({ id: 'p1', ok: true }),
    _detectChannels: () => true,
    _now: () => now,
  });
  await server._register();
  await server._onRequest('tools/call', { name: 'set_summary', arguments: { summary: 'reading the plan', cwd: 'C:/work/repo' } });

  let res = await server._onRequest('tools/call', { name: 'send_message', arguments: { to_id: 'x', message: 'hi' } });
  assert.equal(res.content[0].text.includes('WARNING'), false, 'nagged while fresh');

  now += SUMMARY_STALE_MS;
  res = await server._onRequest('tools/call', { name: 'send_message', arguments: { to_id: 'x', message: 'hi' } });
  assert.match(res.content[0].text, /Message sent to peer x/);
  assert.match(res.content[0].text, /\[claude-peers\] WARNING/);

  // and setting it again clears the nag
  await server._onRequest('tools/call', { name: 'set_summary', arguments: { summary: 'now implementing', cwd: 'C:/work/repo' } });
  res = await server._onRequest('tools/call', { name: 'send_message', arguments: { to_id: 'x', message: 'hi' } });
  assert.equal(res.content[0].text.includes('WARNING'), false, 'still nagging after a refresh');
});

test('an inbound message carries the nag when the receiver own summary is stale', async () => {
  let now = 1_000_000;
  const inbox = [{ id: 1, from_id: 'other', text: 'ping', sent_at: 'now' }];
  const { server, notifications } = (() => {
    const output = new PassThrough();
    const written = [];
    output.on('data', (c) => written.push(c.toString()));
    const s = createPeersServer({
      config: CONFIG, input: new PassThrough(), output,
      _fetch: async (url) => okJson(
        String(url).includes('/poll-messages') ? { messages: inbox.splice(0) }
          : String(url).includes('/list-peers') ? []
            : { id: 'p1', ok: true },
      ),
      _detectChannels: () => true,
      _now: () => now,
    });
    return { server: s, notifications: () => written.join('').split('\n').filter(Boolean).map(JSON.parse) };
  })();

  await server._register();
  await server._onRequest('tools/call', { name: 'set_summary', arguments: { summary: 'reading the plan', cwd: 'C:/work/repo' } });
  now += SUMMARY_STALE_MS;
  await server._poll();

  const pushed = notifications().find(n => n.method === 'notifications/claude/channel');
  assert.ok(pushed, 'no channel notification');
  assert.match(pushed.params.content, /^ping/);
  assert.match(pushed.params.content, /\[claude-peers\] WARNING/);
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
