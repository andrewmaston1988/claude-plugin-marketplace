// Platform probe: what the loaded page's shell offers, whether video plays, which keys reach
// the page, and where navigation can go. Everything it adds to the page is removed in a finally.

import os from 'node:os';
import { join } from 'node:path';
import { evaluate } from '../cdp.mjs';
import { KEYS, dispatchKey } from './keys.mjs';

const NAVIGATE_TIMEOUT_MS = 10000;
const NAVIGATE_POLL_MS = 200;
const VIDEO_ADVANCE_MS = 2000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const messageOf = (error) => String(error?.message ?? error);

export function platformPath(appid) {
  return join(os.tmpdir(), 'ui-probe', `platform-${appid}.json`);
}

// Measured by laying out a hidden box: a property the engine does not know is silently dropped.
const FEATURES_JS = `(() => {
  const tizen = window.tizen;
  const measure = (style, read) => {
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;' + style;
    document.body.appendChild(box);
    let ok = false;
    try { ok = Boolean(read(box)); } catch (error) { ok = false; }
    if (box.parentNode) box.parentNode.removeChild(box);
    return ok;
  };
  return {
    userAgent: navigator.userAgent,
    tizen: typeof tizen,
    tvinputdevice: typeof (tizen && tizen.tvinputdevice),
    application: typeof (tizen && tizen.application),
    webapis: typeof window.webapis,
    IntersectionObserver: typeof window.IntersectionObserver === 'function',
    ResizeObserver: typeof window.ResizeObserver === 'function',
    registerKeyPresent: Boolean(tizen && tizen.tvinputdevice && typeof tizen.tvinputdevice.registerKey === 'function'),
    currentAppPresent: Boolean(tizen && tizen.application && typeof tizen.application.getCurrentApplication === 'function'),
    flexGap: measure('display:flex;column-gap:8px', (box) => {
      const a = document.createElement('span');
      const b = document.createElement('span');
      a.style.cssText = 'display:block;width:10px;height:10px';
      b.style.cssText = 'display:block;width:10px;height:10px';
      box.appendChild(a);
      box.appendChild(b);
      return Math.abs((b.getBoundingClientRect().left - a.getBoundingClientRect().right) - 8) < 1;
    }),
    aspectRatio: measure('width:100px;aspect-ratio:2/1', (box) => Math.abs(box.getBoundingClientRect().height - 50) < 1),
    backdropFilter: measure('backdrop-filter:blur(2px)', (box) => {
      const value = getComputedStyle(box).backdropFilter || getComputedStyle(box).webkitBackdropFilter;
      return Boolean(value) && value !== 'none';
    }),
  };
})()`;

const REGISTER_KEY_JS = `(() => { tizen.tvinputdevice.registerKey('1'); return 'returned'; })()`;
const UNREGISTER_KEY_JS = `(() => { tizen.tvinputdevice.unregisterKey('1'); return 'returned'; })()`;
const CURRENT_APP_JS = `(() => {
  const app = tizen.application.getCurrentApplication();
  return app && typeof app === 'object' ? 'object' : typeof app;
})()`;

const LOCATION_JS = `(() => ({ href: location.href, title: document.title, ready: document.readyState }))()`;

const ALREADY_PLAYING_JS = `(() => Array.from(document.querySelectorAll('video')).some((video) => !video.paused && !video.ended && video.readyState >= 2))()`;

const VIDEO_CREATE_JS = (url) => `(() => {
  const video = document.createElement('video');
  video.src = ${JSON.stringify(url)};
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = 'position:absolute;left:-9999px;top:0;width:320px;height:180px';
  document.body.appendChild(video);
  window.__uiProbeVideo = video;
  return true;
})()`;

const MUTED_PLAY_JS = `(async () => {
  const video = window.__uiProbeVideo;
  video.muted = true;
  let result;
  try { await video.play(); result = 'resolved'; } catch (error) { result = error && error.name ? error.name : String(error); }
  return { result: result, currentTime: video.currentTime, readyState: video.readyState };
})()`;

const UNMUTED_PLAY_JS = `(async () => {
  const video = window.__uiProbeVideo;
  video.muted = false;
  try { await video.play(); return 'resolved'; } catch (error) { return error && error.name ? error.name : String(error); }
})()`;

const VIDEO_STATE_JS = `(() => {
  const video = window.__uiProbeVideo;
  return video ? { currentTime: video.currentTime, readyState: video.readyState } : null;
})()`;

const KEYS_INSTALL_JS = `(() => {
  const log = [];
  const listener = (event) => {
    log.push({ type: event.type, key: event.key, code: event.code, keyCode: event.keyCode });
    event.stopImmediatePropagation();
    event.preventDefault();
  };
  window.addEventListener('keydown', listener, true);
  window.addEventListener('keyup', listener, true);
  window.__uiProbeKey = { log: log, listener: listener, read: () => log.slice() };
  const body = document.body;
  if (body) {
    if (!body.hasAttribute('tabindex')) {
      body.setAttribute('tabindex', '-1');
      body.setAttribute('data-ui-probe-focus', '1');
    }
    body.focus();
  }
  return { active: document.activeElement ? document.activeElement.tagName : null };
})()`;

const KEYS_READ_JS = `(() => (window.__uiProbeKey ? window.__uiProbeKey.read() : []))()`;

const CLEANUP_JS = `(() => {
  const state = window.__uiProbeKey;
  if (state) {
    window.removeEventListener('keydown', state.listener, true);
    window.removeEventListener('keyup', state.listener, true);
    delete window.__uiProbeKey;
  }
  const video = window.__uiProbeVideo;
  if (video && video.parentNode) video.parentNode.removeChild(video);
  delete window.__uiProbeVideo;
  const body = document.body;
  if (body && body.getAttribute('data-ui-probe-focus') === '1') {
    body.removeAttribute('tabindex');
    body.removeAttribute('data-ui-probe-focus');
  }
  return true;
})()`;

function describeOutcome(entry) {
  if (!entry || entry.outcome == null) return 'absent';
  if (entry.outcome === 'threw') return `threw${entry.error ? ` (${entry.error})` : ''}`;
  return entry.outcome;
}

/** The one line a consumer acts on: which shell the loaded page supports. */
export function verdictLine(platform) {
  const features = platform?.features ?? {};
  if (features.tizen !== 'object') {
    return `shell: no tizen — typeof tizen is ${JSON.stringify(features.tizen ?? 'undefined')} in the loaded page`;
  }
  const register = features.registerKey ?? {};
  const current = features.getCurrentApplication ?? {};
  const registerWorks = register.outcome === 'returned';
  const currentWorks = current.outcome === 'returned' && current.returnsObject !== false;
  if (registerWorks && currentWorks) {
    return 'shell: plan A — registerKey("1") returned and getCurrentApplication() returned an object';
  }
  const misses = [];
  if (!registerWorks) misses.push(`registerKey("1") ${describeOutcome(register)}`);
  if (!currentWorks) misses.push(`getCurrentApplication() ${describeOutcome(current)}`);
  return `shell: plan B — ${misses.join('; ')}`;
}

export function platformSummary(platform) {
  const features = platform?.features ?? {};
  return {
    generatedAt: platform?.generatedAt ?? null,
    verdict: platform?.verdict ?? verdictLine(platform ?? {}),
    tizen: features.tizen ?? 'unknown',
    registerKey: features.registerKey?.outcome ?? 'unknown',
    getCurrentApplication: features.getCurrentApplication?.outcome ?? 'unknown',
  };
}

async function readFeatures(cdp) {
  const raw = await evaluate(cdp, FEATURES_JS);
  const registerKey = { present: Boolean(raw.registerKeyPresent), outcome: 'absent' };
  if (registerKey.present) {
    try {
      await evaluate(cdp, REGISTER_KEY_JS);
      registerKey.outcome = 'returned';
    } catch (error) {
      registerKey.outcome = 'threw';
      registerKey.error = messageOf(error);
    }
  }
  const current = { present: Boolean(raw.currentAppPresent), outcome: 'absent' };
  if (current.present) {
    try {
      current.returnsObject = (await evaluate(cdp, CURRENT_APP_JS)) === 'object';
      current.outcome = 'returned';
    } catch (error) {
      current.outcome = 'threw';
      current.error = messageOf(error);
    }
  }
  const { registerKeyPresent, currentAppPresent, ...features } = raw;
  return { ...features, registerKey, getCurrentApplication: current };
}

async function navigateStep(cdp, target, { _sleep }) {
  if (!target) return { requested: null, status: 'skipped' };
  const requested = String(target);
  let before;
  try {
    before = await evaluate(cdp, 'location.href');
  } catch (error) {
    return { requested, status: 'threw', error: messageOf(error) };
  }

  let result;
  try {
    result = await cdp.send('Page.navigate', { url: requested });
  } catch (error) {
    return { requested, status: 'threw', location: before, error: messageOf(error) };
  }

  let state = null;
  const attempts = Math.ceil(NAVIGATE_TIMEOUT_MS / NAVIGATE_POLL_MS);
  for (let i = 0; i < attempts; i += 1) {
    try {
      state = await evaluate(cdp, LOCATION_JS);
    } catch { /* the page is mid-navigation */ }
    if (state && state.href !== before) break;
    if (result?.errorText) break;
    await _sleep(NAVIGATE_POLL_MS);
  }

  const changed = Boolean(state && state.href !== before);
  return {
    requested,
    status: result?.errorText ? 'refused' : changed ? 'reached' : 'refused',
    location: state?.href ?? before,
    title: state?.title ?? null,
    ...(result?.errorText ? { error: result.errorText } : {}),
  };
}

async function videoStep(cdp, url, { _sleep }) {
  if (!url) return { status: 'skipped', reason: 'no --video url' };
  if (await evaluate(cdp, ALREADY_PLAYING_JS)) {
    return { status: 'inconclusive', reason: 'the page already plays a video (one decoder)' };
  }
  try {
    await evaluate(cdp, VIDEO_CREATE_JS(url));
    const muted = await evaluate(cdp, MUTED_PLAY_JS);
    await _sleep(VIDEO_ADVANCE_MS);
    const later = await evaluate(cdp, VIDEO_STATE_JS);
    await dispatchKey(cdp, 'MediaPlay');
    const unmuted = await evaluate(cdp, UNMUTED_PLAY_JS);
    return {
      status: 'measured',
      url,
      mutedPlay: muted?.result ?? null,
      readyState: later?.readyState ?? muted?.readyState ?? null,
      advanced: Boolean(muted && later && later.currentTime > muted.currentTime),
      unmutedPlay: unmuted ?? null,
    };
  } finally {
    await removeEverything(cdp);
  }
}

async function keysStep(cdp, { features, onFixture }) {
  const installed = await evaluate(cdp, KEYS_INSTALL_JS);
  const dispatched = Object.keys(KEYS).filter((name) => onFixture || (name !== 'Back' && name !== 'Enter'));
  let events = [];
  let registered = null;
  try {
    for (const name of dispatched) await dispatchKey(cdp, name);
    events = (await evaluate(cdp, KEYS_READ_JS)) ?? [];
    if (features?.registerKey?.outcome === 'returned') {
      registered = { key: 'Digit1' };
      try {
        await evaluate(cdp, REGISTER_KEY_JS);
        registered.register = 'returned';
      } catch (error) {
        registered.register = 'threw';
        registered.error = messageOf(error);
      }
      await dispatchKey(cdp, 'Digit1');
      try {
        await evaluate(cdp, UNREGISTER_KEY_JS);
        registered.unregister = 'returned';
      } catch {
        registered.unregister = 'threw';
      }
    }
  } finally {
    await removeEverything(cdp);
  }
  return {
    status: 'measured',
    onFixture,
    activeElement: installed?.active ?? null,
    swallow: 'holds only for listeners below the window capture phase',
    dispatched,
    events: Array.isArray(events) ? events : [],
    registered,
  };
}

async function listenStep(cdp, seconds, { _sleep, onFixture }) {
  const length = Number(seconds);
  if (!Number.isFinite(length) || length <= 0) return { status: 'skipped', seconds: 0 };
  await evaluate(cdp, KEYS_INSTALL_JS);
  let events = [];
  try {
    await _sleep(length * 1000);
    events = (await evaluate(cdp, KEYS_READ_JS)) ?? [];
  } finally {
    await removeEverything(cdp);
  }
  return { status: 'measured', seconds: length, onFixture, events: Array.isArray(events) ? events : [] };
}

async function removeEverything(cdp) {
  try {
    await evaluate(cdp, CLEANUP_JS);
  } catch { /* the socket may be gone; nothing is left to remove then */ }
}

async function guardedStep(step) {
  try {
    return await step();
  } catch (error) {
    return { status: 'error', error: messageOf(error) };
  }
}

/**
 * Measure the platform without changing it. `navigate` is the only step that moves the page;
 * Back and Enter are dispatched only after it has landed on the test origin, because either can
 * leave or act on the live app.
 */
export async function tvProbe(cdp, { video = null, navigate = null, listenSeconds = null, _sleep = defaultSleep } = {}) {
  const platform = {
    schema: 'ui-probe-platform@1',
    generatedAt: new Date().toISOString(),
    features: null,
    navigate: null,
    video: null,
    keys: null,
    listen: null,
    verdict: null,
  };

  try {
    platform.features = await readFeatures(cdp);
    platform.navigate = await navigateStep(cdp, navigate, { _sleep });
    const onFixture = platform.navigate?.status === 'reached';
    platform.video = await guardedStep(() => videoStep(cdp, video, { _sleep }));
    platform.keys = await guardedStep(() => keysStep(cdp, { features: platform.features, onFixture }));
    platform.listen = await guardedStep(() => listenStep(cdp, listenSeconds, { _sleep, onFixture }));
  } finally {
    await removeEverything(cdp);
  }

  platform.verdict = verdictLine(platform);
  return platform;
}
