import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyState, loadState, saveState } from '../src/broker/store.mjs';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peers-store-'));
  return path.join(dir, 'state.json');
}

test('loadState: missing file returns the empty shape', () => {
  assert.deepEqual(loadState(tmpFile()), { peers: {}, messages: [] });
});

test('loadState: corrupt JSON throws, never returns partial state', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{ not json');
  assert.throws(() => loadState(f));
});

test('loadState: valid JSON with the wrong shape throws', () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ peers: [], messages: {} }));
  assert.throws(() => loadState(f), /shape/);
});

// Review finding #1: typeof null === "object" must not slip past the guard —
// a null peers map would permanently 500 every handler with no self-repair.
test('loadState: peers: null is a shape error, not a pass', () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ peers: null, messages: [] }));
  assert.throws(() => loadState(f), /shape/);
});

test('save then load round-trips', () => {
  const f = tmpFile();
  const state = emptyState();
  state.peers.ab12cd34 = { id: 'ab12cd34', pid: 123, cwd: 'C:/x', git_root: null, tty: null, summary: '', kind: 'session', registered_at: 't', last_seen: 't' };
  state.messages.push({ id: 1, from_id: 'a', to_id: 'ab12cd34', text: 'hi', sent_at: 't', delivered: false });
  saveState(f, state);
  assert.deepEqual(loadState(f), state);
});

test('saveState writes a .tmp then renames — never the final path directly', () => {
  const calls = [];
  const _fs = {
    mkdirSync: () => {},
    writeFileSync: (p) => calls.push(['write', p]),
    renameSync: (a, b) => calls.push(['rename', a, b]),
  };
  saveState('C:/x/state.json', emptyState(), { _fs });
  assert.deepEqual(calls, [
    ['write', 'C:/x/state.json.tmp'],
    ['rename', 'C:/x/state.json.tmp', 'C:/x/state.json'],
  ]);
});
