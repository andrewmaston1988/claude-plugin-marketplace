// The probe's individual steps and the page scripts they evaluate. Each records the page it ran
// on, so a digest never mixes two documents into one claim.

import { evaluate } from '../cdp.mjs';
import { KEYS, dispatchKey } from './keys.mjs';

const NAVIGATE_TIMEOUT_MS = 10000;
const NAVIGATE_POLL_MS = 200;
const VIDEO_ADVANCE_MS = 2000;
const EXIT_TIMEOUT_MS = 3000;
const EXIT_POLL_MS = 250;

export const messageOf = (error) => String(error?.message ?? error);

// Every read below names the same page: a probe that mixes documents reports two pages as one.
const PAGE_JS = `(() => ({ href: location.href, origin: location.origin }))()`;

// Measured by laying out a hidden box: a property the engine does not know is silently dropped.
// A document without a body cannot lay anything out, so the measurement reports absent rather
// than throwing on an append.
export const FEATURES_JS = `(() => {
  const tizen = window.tizen;
  const measure = (style, read) => {
    const body = document.body;
    if (!body) return false;
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;' + style;
    body.appendChild(box);
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

const REGISTER_KEY_JS = `(() => { window.tizen.tvinputdevice.registerKey('1'); return 'returned'; })()`;
const UNREGISTER_KEY_JS = `(() => { window.tizen.tvinputdevice.unregisterKey('1'); return 'returned'; })()`;
const CURRENT_APP_JS = `(() => {
  const app = window.tizen.application.getCurrentApplication();
  return app && typeof app === 'object' ? 'object' : typeof app;
})()`;

const LOCATION_JS = `(() => ({ href: location.href, origin: location.origin, title: document.title, ready: document.readyState }))()`;

const ALREADY_PLAYING_JS = `(() => Array.from(document.querySelectorAll('video')).some((video) => !video.paused && !video.ended && video.readyState >= 2))()`;

const EXIT_JS = `(() => {
  window.tizen.application.getCurrentApplication().exit();
  return 'called';
})()`;
// An app that closed takes its inspector with it, so a reply that never comes is the result.
const EXIT_POLL_JS = '1 + 1';

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

// A cross-origin response hides its headers unless the server exposes them, so a null header
// here is the measurement, not a missing one. The in-page catch is the only way to learn the
// kind of failure: a CORS refusal rejects with a bare TypeError and no status.
const FETCH_JS = (url) => `(async () => {
  try {
    const response = await fetch(${JSON.stringify(url)}, { method: 'GET', credentials: 'include' });
    return {
      httpStatus: response.status,
      type: response.type,
      allowOrigin: response.headers.get('Access-Control-Allow-Origin'),
      allowCredentials: response.headers.get('Access-Control-Allow-Credentials'),
    };
  } catch (error) {
    return {
      error: error && error.name ? error.name : 'Error',
      message: error && error.message ? error.message : String(error),
    };
  }
})()`;

export const KEYS_INSTALL_JS = `(() => {
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

export const KEYS_READ_JS = `(() => (window.__uiProbeKey ? window.__uiProbeKey.read() : []))()`;

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
  // Every element the probe adds carries this prefix, so one sweep cannot miss a new one.
  const leftovers = document.querySelectorAll('[id^="__ui-probe"]');
  for (let i = 0; i < leftovers.length; i += 1) {
    if (leftovers[i].parentNode) leftovers[i].parentNode.removeChild(leftovers[i]);
  }
  return true;
})()`;

/** The page a step ran on. A read that fails leaves it unnamed rather than failing the step. */
export async function pageOf(cdp) {
  try {
    const value = await evaluate(cdp, PAGE_JS);
    if (value && typeof value.href === 'string') return { href: value.href, origin: value.origin ?? null };
  } catch { /* the page may be mid-navigation */ }
  return { href: null, origin: null };
}

export async function readFeatures(cdp) {
  const page = await pageOf(cdp);
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
  return { ...features, page, registerKey, getCurrentApplication: current };
}

export async function navigateStep(cdp, target, { _sleep }) {
  const page = await pageOf(cdp);
  if (!target) return { requested: null, status: 'skipped', page };
  const requested = String(target);
  const before = page.href;
  if (!before) {
    return { requested, status: 'threw', page, error: 'location.href could not be read' };
  }

  let result;
  try {
    result = await cdp.send('Page.navigate', { url: requested });
  } catch (error) {
    return { requested, status: 'threw', page, location: before, error: messageOf(error) };
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
    page,
    status: result?.errorText ? 'refused' : changed ? 'reached' : 'refused',
    location: state?.href ?? before,
    origin: state?.origin ?? null,
    title: state?.title ?? null,
    ...(result?.errorText ? { error: result.errorText } : {}),
  };
}

export async function videoStep(cdp, url, { _sleep }) {
  const page = await pageOf(cdp);
  if (!url) return { status: 'skipped', reason: 'no --video url', page };
  if (await evaluate(cdp, ALREADY_PLAYING_JS)) {
    return { status: 'inconclusive', reason: 'the page already plays a video (one decoder)', page };
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
      page,
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

export async function keysStep(cdp, { features, onFixture }) {
  const page = await pageOf(cdp);
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
    page,
    onFixture,
    activeElement: installed?.active ?? null,
    swallow: 'holds only for listeners below the window capture phase',
    dispatched,
    events: Array.isArray(events) ? events : [],
    registered,
  };
}

export async function fetchStep(cdp, url) {
  const page = await pageOf(cdp);
  if (!url) return { status: 'skipped', reason: 'no --fetch url', page };
  const result = await evaluate(cdp, FETCH_JS(url));
  if (!result || typeof result !== 'object') {
    return { status: 'error', url, page, error: 'the page returned no result' };
  }
  if (result.error) {
    return { status: 'error', url, page, method: 'GET', error: result.error, message: result.message ?? null };
  }
  return {
    status: 'measured',
    url,
    page,
    method: 'GET',
    httpStatus: result.httpStatus ?? null,
    type: result.type ?? null,
    allowOrigin: result.allowOrigin ?? null,
    allowCredentials: result.allowCredentials ?? null,
  };
}

export async function exitStep(cdp, { _sleep, _now }) {
  const page = await pageOf(cdp);
  const started = _now();
  let called = 'returned';
  let error = null;
  try {
    await evaluate(cdp, EXIT_JS);
  } catch (failure) {
    // The socket can go before the reply: that is still the app closing.
    called = 'threw';
    error = messageOf(failure);
  }

  let closed = false;
  const attempts = Math.max(1, Math.ceil(EXIT_TIMEOUT_MS / EXIT_POLL_MS) + 1);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await _sleep(EXIT_POLL_MS);
    try {
      await evaluate(cdp, EXIT_POLL_JS);
    } catch {
      closed = true;
      break;
    }
    if (_now() - started >= EXIT_TIMEOUT_MS) break;
  }

  return {
    status: 'measured',
    page,
    called,
    closed,
    ms: _now() - started,
    ...(error ? { error } : {}),
  };
}

export async function removeEverything(cdp) {
  try {
    await evaluate(cdp, CLEANUP_JS);
  } catch { /* the socket may be gone; nothing is left to remove then */ }
}

export async function guardedStep(step) {
  try {
    return await step();
  } catch (error) {
    return { status: 'error', error: messageOf(error) };
  }
}
