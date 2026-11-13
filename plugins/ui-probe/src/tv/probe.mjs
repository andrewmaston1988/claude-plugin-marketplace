// Platform probe: what the loaded page's shell offers, whether video plays, which keys reach
// the page, and where navigation can go. The steps live in steps.mjs; this file runs them and
// turns the evidence into the one line a consumer acts on.

import os from 'node:os';
import { join } from 'node:path';
import {
  exitStep,
  fetchStep,
  guardedStep,
  keysStep,
  navigateStep,
  readFeatures,
  removeEverything,
  videoStep,
} from './steps.mjs';
import { listenStep } from './listen.mjs';

export { FEATURES_JS, pageOf } from './steps.mjs';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function platformPath(appid) {
  return join(os.tmpdir(), 'ui-probe', `platform-${appid}.json`);
}

function describeOutcome(entry) {
  if (!entry || entry.outcome == null) return 'absent';
  if (entry.outcome === 'threw') return `threw${entry.error ? ` (${entry.error})` : ''}`;
  return entry.outcome;
}

/** The transport and exit evidence a plan B claim stands beside, never part of it. */
function planBEvidence(platform) {
  const parts = [];
  const fetched = platform?.fetch;
  if (fetched?.status === 'measured') parts.push(`--fetch ${fetched.httpStatus ?? 'no status'}`);
  else if (fetched?.status === 'error') parts.push(`--fetch failed (${fetched.error ?? 'error'})`);
  const exited = platform?.exit;
  if (exited) parts.push(`--exit closed ${Boolean(exited.closed)}`);
  return parts.length ? ` (${parts.join('; ')})` : '';
}

/**
 * The one line a consumer acts on: which shell the settled page supports. It names the page it
 * measured, because presence read on one document and calls made on another is no evidence at
 * all — and presence alone is never a plan, only calls that returned are.
 */
export function verdictLine(platform) {
  const features = platform?.features ?? {};
  const page = features.page ?? platform?.page ?? null;
  const href = typeof page?.href === 'string' && page.href ? page.href : null;
  if (!href) {
    return 'shell: undetermined — the page could not be read, so neither plan A nor plan B can be claimed';
  }

  const register = features.registerKey ?? {};
  const current = features.getCurrentApplication ?? {};
  const registerWorks = register.outcome === 'returned';
  const currentWorks = current.outcome === 'returned' && current.returnsObject !== false;
  const calls = 'registerKey("1") returned and getCurrentApplication() returned an object';
  if (features.tizen === 'object' && registerWorks && currentWorks) {
    // The widget-local page is the only one that can prove plan B; its evidence rides beside.
    return /^https?:/i.test(href)
      ? `shell: plan A — ${calls} on ${href}`
      : `shell: plan B — ${calls} on ${href}${planBEvidence(platform)}`;
  }

  const misses = [];
  if (features.tizen !== 'object') misses.push(`typeof tizen is ${JSON.stringify(features.tizen ?? 'undefined')}`);
  if (!registerWorks) misses.push(`registerKey("1") ${describeOutcome(register)}`);
  if (!currentWorks) misses.push(`getCurrentApplication() ${describeOutcome(current)}`);
  return `shell: no tizen — ${misses.join('; ')} on ${href}`;
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

/**
 * Measure the platform without changing it. `navigate` is the only step that moves the page;
 * Back and Enter are dispatched only after it has landed on the test origin, because either can
 * leave or act on the live app.
 */
export async function tvProbe(cdp, {
  video = null,
  navigate = null,
  listenKeys = null,
  listenWaitSeconds = null,
  fetch = null,
  exit = false,
  _note = null,
  _sleep = defaultSleep,
  _now = Date.now,
} = {}) {
  const platform = {
    schema: 'ui-probe-platform@1',
    generatedAt: new Date().toISOString(),
    page: null,
    features: null,
    navigate: null,
    video: null,
    keys: null,
    listen: null,
    fetch: null,
    exit: null,
    verdict: null,
  };

  try {
    platform.features = await readFeatures(cdp);
    // The page the features and the calls were both read from; the verdict names it.
    platform.page = platform.features.page;
    platform.navigate = await navigateStep(cdp, navigate, { _sleep });
    const onFixture = platform.navigate?.status === 'reached';
    platform.video = await guardedStep(() => videoStep(cdp, video, { _sleep }));
    platform.keys = await guardedStep(() => keysStep(cdp, { features: platform.features, onFixture }));
    platform.listen = await guardedStep(() => listenStep(cdp, {
      requested: listenKeys,
      waitSeconds: listenWaitSeconds,
      onFixture,
      _sleep,
      _note,
    }));
    platform.fetch = await guardedStep(() => fetchStep(cdp, fetch));
  } finally {
    await removeEverything(cdp);
  }

  // Last of all: once the app exits, nothing else can be measured.
  if (exit) platform.exit = await guardedStep(() => exitStep(cdp, { _sleep, _now }));
  platform.verdict = verdictLine(platform);
  return platform;
}
