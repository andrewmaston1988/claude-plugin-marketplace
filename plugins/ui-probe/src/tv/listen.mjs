// The guided physical-press check: one key at a time, an on-screen prompt the operator can act
// on, the fields that arrived echoed back, and a per-key record for platform.json.

import { evaluate } from '../cdp.mjs';
import { KEYS, isKnownKey } from './keys.mjs';
import { KEYS_INSTALL_JS, KEYS_READ_JS, pageOf, removeEverything } from './steps.mjs';

const POLL_MS = 200;
const HOLD_MS = 1000;

export const DEFAULT_LISTEN_KEYS = Object.freeze(['Left', 'Right', 'Digit1', 'MediaPlay']);
// Back at the app's root exits it, so these are offered only on a page the probe navigated to.
const FIXTURE_ONLY_KEYS = Object.freeze(['Enter', 'Back']);
export const DEFAULT_LISTEN_WAIT_SECONDS = 8;

// What the operator reads on the remote, not the table's name for the key.
const LABELS = Object.freeze({
  Enter: 'OK',
  MediaPlay: 'Play',
  MediaPause: 'Pause',
  MediaPlayPause: 'Play/Pause',
  MediaStop: 'Stop',
  MediaRewind: 'Rewind',
  MediaFastForward: 'Fast forward',
});

export function listenLabel(name) {
  const entry = KEYS[name];
  if (!entry) return name;
  if (/^Digit[0-9]$/.test(name)) return entry.key;
  return LABELS[name] ?? name;
}

export function parseListenKeys(value) {
  const names = String(value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  if (!names.length) {
    throw new Error(`--listen needs at least one key name (${Object.keys(KEYS).join(', ')})`);
  }
  const unknown = names.find((name) => !isKnownKey(name));
  if (unknown) {
    throw new Error(`unknown key ${JSON.stringify(unknown)}: --listen takes comma-separated key names `
      + `(${Object.keys(KEYS).join(', ')}), and --listen-wait sets the seconds to wait for each`);
  }
  return names;
}

export function listenKeysFor({ requested = null, onFixture = false } = {}) {
  if (requested) return parseListenKeys(Array.isArray(requested) ? requested.join(',') : requested);
  return onFixture ? [...DEFAULT_LISTEN_KEYS, ...FIXTURE_ONLY_KEYS] : [...DEFAULT_LISTEN_KEYS];
}

export function listenAnnouncement(keys, waitSeconds) {
  const labels = keys.map(listenLabel).join(', ');
  return `listen: ${keys.length} keys, ${waitSeconds}s each — press ${labels} on the remote, one at a time`;
}

// Chromium 69 on the set: no inset, no flex gap, no aspect-ratio. Fixed, top, full width, large.
const OVERLAY_STYLE = 'position:fixed;left:0;right:0;top:0;width:100%;box-sizing:border-box;'
  + 'z-index:2147483647;background:#000;color:#fff;text-align:center;padding:40px 24px;'
  + 'font-family:sans-serif;font-size:52px;line-height:1.3;white-space:pre-line;pointer-events:none';

// The mark is set before the prompt is painted, so a press landing as the key is named counts.
const promptJs = (text) => `(() => {
  const state = window.__uiProbeKey;
  // Without the listener every key would read "not received": that is a broken probe, not a miss.
  if (!state) throw new Error('the key listener is not installed');
  let box = document.getElementById('__ui-probe-listen');
  if (!box) {
    box = document.createElement('div');
    box.id = '__ui-probe-listen';
    box.style.cssText = ${JSON.stringify(OVERLAY_STYLE)};
    (document.body || document.documentElement).appendChild(box);
  }
  state.mark = state.log.length;
  box.textContent = ${JSON.stringify(text)};
  return true;
})()`;

const resultJs = (text) => `(() => {
  const box = document.getElementById('__ui-probe-listen');
  if (box) box.textContent = ${JSON.stringify(text)};
  return true;
})()`;

const readJs = `(() => {
  const state = window.__uiProbeKey;
  if (!state) return { events: [] };
  return { events: state.log.slice(state.mark || 0) };
})()`;

const receivedText = (name, event) =>
  `✓ ${listenLabel(name)} — key ${event.key}, code ${event.code}, keyCode ${event.keyCode}`;

const missingText = (name) => `✗ ${listenLabel(name)} — not received`;

/**
 * Prompt each key in turn. The capture listener records and swallows every event, so an
 * unexpected press is kept in the log while the prompt waits for its own keyCode.
 */
export async function listenStep(cdp, {
  requested = null,
  waitSeconds = null,
  onFixture = false,
  _sleep,
  _note = null,
} = {}) {
  const page = await pageOf(cdp);
  const wait = Number(waitSeconds);
  if (!Number.isFinite(wait) || wait <= 0) return { status: 'skipped', waitSeconds: 0, page };

  const keys = listenKeysFor({ requested, onFixture });
  const attempts = Math.max(1, Math.ceil((wait * 1000) / POLL_MS));
  await evaluate(cdp, KEYS_INSTALL_JS);

  const results = [];
  let events = [];
  try {
    if (_note) _note(listenAnnouncement(keys, wait));
    for (let index = 0; index < keys.length; index += 1) {
      const name = keys[index];
      const keyCode = KEYS[name].keyCode;
      await evaluate(cdp, promptJs(`Press ${listenLabel(name)} on the remote`));

      let event = null;
      for (let attempt = 0; attempt < attempts && !event; attempt += 1) {
        const read = await evaluate(cdp, readJs);
        event = (read?.events ?? []).find((one) => one.type === 'keydown' && one.keyCode === keyCode) ?? null;
        if (!event) await _sleep(POLL_MS);
      }

      await evaluate(cdp, resultJs(event ? receivedText(name, event) : missingText(name)));
      results.push({ key: name, received: Boolean(event), ...(event ? { event } : {}) });
      if (index < keys.length - 1) await _sleep(HOLD_MS);
    }
    events = (await evaluate(cdp, KEYS_READ_JS)) ?? [];
  } finally {
    await removeEverything(cdp);
  }

  return {
    status: 'measured',
    page,
    waitSeconds: wait,
    onFixture,
    keys,
    results,
    events: Array.isArray(events) ? events : [],
  };
}
