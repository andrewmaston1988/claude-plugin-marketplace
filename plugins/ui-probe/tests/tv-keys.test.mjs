import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, isKnownKey, dispatchKey } from '../src/tv/keys.mjs';

const EXPECTED = {
  Left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  Up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  Right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Back: { key: 'GoBack', code: 'GoBack', keyCode: 10009 },
  Digit0: { key: '0', code: 'Digit0', keyCode: 48 },
  Digit1: { key: '1', code: 'Digit1', keyCode: 49 },
  Digit2: { key: '2', code: 'Digit2', keyCode: 50 },
  Digit3: { key: '3', code: 'Digit3', keyCode: 51 },
  Digit4: { key: '4', code: 'Digit4', keyCode: 52 },
  Digit5: { key: '5', code: 'Digit5', keyCode: 53 },
  Digit6: { key: '6', code: 'Digit6', keyCode: 54 },
  Digit7: { key: '7', code: 'Digit7', keyCode: 55 },
  Digit8: { key: '8', code: 'Digit8', keyCode: 56 },
  Digit9: { key: '9', code: 'Digit9', keyCode: 57 },
  MediaPlay: { key: 'MediaPlay', code: 'MediaPlay', keyCode: 415 },
  MediaPause: { key: 'MediaPause', code: 'MediaPause', keyCode: 19 },
  MediaPlayPause: { key: 'MediaPlayPause', code: 'MediaPlayPause', keyCode: 10252 },
  MediaStop: { key: 'MediaStop', code: 'MediaStop', keyCode: 413 },
  MediaRewind: { key: 'MediaRewind', code: 'MediaRewind', keyCode: 412 },
  MediaFastForward: { key: 'MediaFastForward', code: 'MediaFastForward', keyCode: 417 },
};

function stubCdp() {
  const calls = [];
  return {
    calls,
    async send(method, params = {}) {
      calls.push({ method, params });
      return {};
    },
  };
}

const noSleep = async () => {};

test('KEYS holds exactly the expected table with key, code and keyCode', () => {
  assert.deepEqual(Object.keys(KEYS).sort(), Object.keys(EXPECTED).sort());
  for (const [name, want] of Object.entries(EXPECTED)) {
    assert.deepEqual(KEYS[name], want, `KEYS.${name}`);
  }
});

test('Exit (10182) is not in the table', () => {
  assert.ok(!('Exit' in KEYS));
  assert.equal(isKnownKey('Exit'), false);
});

test('isKnownKey recognises table keys and rejects others', () => {
  assert.equal(isKnownKey('Left'), true);
  assert.equal(isKnownKey('MediaFastForward'), true);
  assert.equal(isKnownKey('Nope'), false);
  assert.equal(isKnownKey(''), false);
  assert.equal(isKnownKey(undefined), false);
});

test('dispatchKey sends rawKeyDown then keyUp with the table codes', async () => {
  const cdp = stubCdp();
  await dispatchKey(cdp, 'Left', { _sleep: noSleep });
  assert.deepEqual(cdp.calls, [
    { method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 } },
    { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 } },
  ]);
});

test('dispatchKey repeat: 3 sends three pairs, gapMs apart', async () => {
  const cdp = stubCdp();
  const sleeps = [];
  await dispatchKey(cdp, 'Enter', { repeat: 3, gapMs: 250, _sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(cdp.calls.length, 6);
  assert.deepEqual(cdp.calls.map((c) => c.params.type), ['rawKeyDown', 'keyUp', 'rawKeyDown', 'keyUp', 'rawKeyDown', 'keyUp']);
  assert.deepEqual(sleeps, [250, 250]);
});

test('gapMs defaults to 120', async () => {
  const cdp = stubCdp();
  const sleeps = [];
  await dispatchKey(cdp, 'Down', { repeat: 2, _sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(sleeps, [120]);
});

test('autoRepeat sets autoRepeat on the second and later rawKeyDown only', async () => {
  const cdp = stubCdp();
  await dispatchKey(cdp, 'Right', { repeat: 3, autoRepeat: true, _sleep: noSleep });
  const downs = cdp.calls.filter((c) => c.params.type === 'rawKeyDown').map((c) => c.params);
  const ups = cdp.calls.filter((c) => c.params.type === 'keyUp').map((c) => c.params);
  assert.equal(downs[0].autoRepeat, undefined);
  assert.equal(downs[1].autoRepeat, true);
  assert.equal(downs[2].autoRepeat, true);
  for (const up of ups) assert.equal(up.autoRepeat, undefined);
});

test('autoRepeat stays off by default', async () => {
  const cdp = stubCdp();
  await dispatchKey(cdp, 'Right', { repeat: 2, _sleep: noSleep });
  for (const call of cdp.calls) assert.equal(call.params.autoRepeat, undefined);
});

test('dispatchKey rejects an unknown key naming it', async () => {
  const cdp = stubCdp();
  await assert.rejects(() => dispatchKey(cdp, 'VolumeUp', { _sleep: noSleep }), /VolumeUp/);
  assert.equal(cdp.calls.length, 0);
});

test('dispatchKey rejects a non-integer or <1 repeat', async () => {
  const cdp = stubCdp();
  await assert.rejects(() => dispatchKey(cdp, 'Left', { repeat: 0, _sleep: noSleep }));
  await assert.rejects(() => dispatchKey(cdp, 'Left', { repeat: 1.5, _sleep: noSleep }));
  assert.equal(cdp.calls.length, 0);
});
