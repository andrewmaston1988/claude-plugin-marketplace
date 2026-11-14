// Tizen TV remote key table. Exit (10182) is deliberately absent: Samsung
// certification forbids exiting the app from the remote's Exit key.
export const KEYS = Object.freeze({
  Left: Object.freeze({ key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }),
  Up: Object.freeze({ key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }),
  Right: Object.freeze({ key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 }),
  Down: Object.freeze({ key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 }),
  Enter: Object.freeze({ key: 'Enter', code: 'Enter', keyCode: 13 }),
  Back: Object.freeze({ key: 'GoBack', code: 'GoBack', keyCode: 10009 }),
  Digit0: Object.freeze({ key: '0', code: 'Digit0', keyCode: 48 }),
  Digit1: Object.freeze({ key: '1', code: 'Digit1', keyCode: 49 }),
  Digit2: Object.freeze({ key: '2', code: 'Digit2', keyCode: 50 }),
  Digit3: Object.freeze({ key: '3', code: 'Digit3', keyCode: 51 }),
  Digit4: Object.freeze({ key: '4', code: 'Digit4', keyCode: 52 }),
  Digit5: Object.freeze({ key: '5', code: 'Digit5', keyCode: 53 }),
  Digit6: Object.freeze({ key: '6', code: 'Digit6', keyCode: 54 }),
  Digit7: Object.freeze({ key: '7', code: 'Digit7', keyCode: 55 }),
  Digit8: Object.freeze({ key: '8', code: 'Digit8', keyCode: 56 }),
  Digit9: Object.freeze({ key: '9', code: 'Digit9', keyCode: 57 }),
  MediaPlay: Object.freeze({ key: 'MediaPlay', code: 'MediaPlay', keyCode: 415 }),
  MediaPause: Object.freeze({ key: 'MediaPause', code: 'MediaPause', keyCode: 19 }),
  MediaPlayPause: Object.freeze({ key: 'MediaPlayPause', code: 'MediaPlayPause', keyCode: 10252 }),
  MediaStop: Object.freeze({ key: 'MediaStop', code: 'MediaStop', keyCode: 413 }),
  MediaRewind: Object.freeze({ key: 'MediaRewind', code: 'MediaRewind', keyCode: 412 }),
  MediaFastForward: Object.freeze({ key: 'MediaFastForward', code: 'MediaFastForward', keyCode: 417 }),
});

export function isKnownKey(name) {
  return Object.prototype.hasOwnProperty.call(KEYS, name);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function dispatchKey(cdp, name, { repeat = 1, gapMs = 120, autoRepeat = false, _sleep = defaultSleep } = {}) {
  const entry = KEYS[name];
  if (!entry) {
    throw new Error(`unknown key ${JSON.stringify(name)}; known keys: ${Object.keys(KEYS).join(', ')}`);
  }
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error(`repeat must be a positive integer, got ${JSON.stringify(repeat)}`);
  }
  for (let i = 0; i < repeat; i++) {
    if (i > 0) await _sleep(gapMs);
    const down = {
      type: 'rawKeyDown',
      key: entry.key,
      code: entry.code,
      windowsVirtualKeyCode: entry.keyCode,
      nativeVirtualKeyCode: entry.keyCode,
    };
    if (autoRepeat && i > 0) down.autoRepeat = true;
    await cdp.send('Input.dispatchKeyEvent', down);
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: entry.key,
      code: entry.code,
      windowsVirtualKeyCode: entry.keyCode,
      nativeVirtualKeyCode: entry.keyCode,
    });
  }
}
