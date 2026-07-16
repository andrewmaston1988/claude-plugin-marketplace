import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRpcEndpoint } from '../src/mcp/jsonrpc.mjs';

function harness(onRequest) {
  const input = new PassThrough();
  const output = new PassThrough();
  const written = [];
  output.on('data', (c) => written.push(c.toString()));
  const rpc = createRpcEndpoint({ input, output, onRequest });
  const lines = () => written.join('').split('\n').filter(Boolean).map(JSON.parse);
  return { input, rpc, lines };
}

const tick = () => new Promise((r) => setImmediate(r));

test('parses requests split across arbitrary chunk boundaries', async () => {
  const seen = [];
  const { input, lines } = harness(async (method, params) => { seen.push([method, params]); return { ok: 1 }; });
  const msg = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'x/y', params: { a: 1 } }) + '\n';
  input.write(msg.slice(0, 5));
  input.write(msg.slice(5, 20));
  input.write(msg.slice(20));
  await tick(); await tick();
  assert.deepEqual(seen, [['x/y', { a: 1 }]]);
  assert.deepEqual(lines(), [{ jsonrpc: '2.0', id: 7, result: { ok: 1 } }]);
});

test('two messages in one chunk are both handled', async () => {
  const seen = [];
  const { input, lines } = harness(async (m) => { seen.push(m); return {}; });
  input.write(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'a' }) + '\n' +
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'b' }) + '\n'
  );
  await tick(); await tick();
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(lines().length, 2);
});

test('responses and notifications are single lines of pure JSON', async () => {
  const { input, rpc, lines } = harness(async () => ({ fine: true }));
  rpc.notify('notifications/claude/channel', { content: 'hi', meta: { from_id: 'x' } });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'm' }) + '\n');
  await tick(); await tick();
  for (const line of lines()) {
    assert.equal(typeof line.jsonrpc, 'string'); // every emitted line parses as JSON-RPC
  }
  assert.deepEqual(lines()[0], { jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: 'hi', meta: { from_id: 'x' } } });
});

test('malformed input gets a -32700 error response and the loop survives', async () => {
  const { input, lines } = harness(async () => ({ alive: true }));
  input.write('this is not json\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'still/works' }) + '\n');
  await tick(); await tick();
  const out = lines();
  assert.equal(out[0].error.code, -32700);
  assert.deepEqual(out[1], { jsonrpc: '2.0', id: 9, result: { alive: true } });
});

test('a handler throw becomes a JSON-RPC error, with the method-not-found code honoured', async () => {
  const { input, lines } = harness(async (method) => {
    const e = new Error(`Unknown method: ${method}`);
    e.rpcCode = -32601;
    throw e;
  });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'nope' }) + '\n');
  await tick(); await tick();
  assert.equal(lines()[0].error.code, -32601);
});

test('notifications (no id) invoke the handler but never produce a response', async () => {
  const seen = [];
  const input = new PassThrough();
  const output = new PassThrough();
  const written = [];
  output.on('data', (c) => written.push(c.toString()));
  createRpcEndpoint({ input, output, onRequest: async () => ({ should: 'not appear' }), onNotification: async (m) => seen.push(m) });
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await tick(); await tick();
  assert.deepEqual(seen, ['notifications/initialized']);
  assert.equal(written.join(''), '');
});
