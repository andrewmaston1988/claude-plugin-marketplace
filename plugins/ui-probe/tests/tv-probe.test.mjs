import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FEATURES_JS, platformPath, platformSummary, tvProbe, verdictLine } from '../src/tv/probe.mjs';
import { noSleep, stubCdp } from './tv-support.mjs';

const PAGE = { href: 'http://192.0.2.30:8000/tv?tizen=1', origin: 'http://192.0.2.30:8000' };
const pageReply = (value = PAGE) => ({ match: (e) => e.includes('location.origin'), value, sticky: true });

const featuresValue = (overrides = {}) => ({
  userAgent: 'Mozilla/5.0 (SMART-TV)',
  tizen: 'object',
  tvinputdevice: 'object',
  application: 'object',
  webapis: 'object',
  IntersectionObserver: true,
  ResizeObserver: false,
  flexGap: false,
  aspectRatio: false,
  backdropFilter: false,
  registerKeyPresent: true,
  currentAppPresent: true,
  ...overrides,
});

const featuresReply = (overrides) => ({ match: (e) => e.includes('IntersectionObserver'), value: featuresValue(overrides) });
const registerReply = (value) => ({ match: (e) => e.includes('registerKey'), value });
const currentReply = (value) => ({ match: (e) => e.includes('getCurrentApplication'), value });
const installReply = { match: (e) => e.includes('__uiProbeKey ='), value: { active: 'BODY' } };
const readReply = (value) => ({ match: (e) => e.includes('__uiProbeKey.read()'), value });
const cleanupReply = { match: (e) => e.includes('removeEventListener'), value: true };

const plainRun = (overrides = {}) => [
  pageReply(PAGE),
  featuresReply(),
  registerReply('returned'),
  currentReply('object'),
  installReply,
  readReply([{ type: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }]),
  cleanupReply,
  ...(overrides.extra ?? []),
];

const keyCodes = (cdp) => cdp.sent('Input.dispatchKeyEvent').map((call) => call.params.windowsVirtualKeyCode);

// Row 15
test('tvProbe removes every listener and element it added, and returns the measured platform', async () => {
  const cdp = stubCdp({ replies: plainRun() });
  const platform = await tvProbe(cdp, { _sleep: noSleep });

  assert.match(cdp.sent('Runtime.evaluate').at(-1).params.expression, /removeEventListener/);
  assert.match(cdp.sent('Runtime.evaluate').at(-1).params.expression, /__uiProbeVideo/);
  assert.equal(platform.features.registerKey.outcome, 'returned');
  assert.equal(platform.keys.status, 'measured');
  assert.equal(platform.keys.events.length, 1);
  assert.match(platform.verdict, /^shell: plan A/);
});

// Row 15
test('tvProbe still removes everything when a step throws', async () => {
  const cdp = stubCdp({
    replies: [
      featuresReply(),
      registerReply('returned'),
      currentReply('object'),
      installReply,
      { match: (e) => e.includes('__uiProbeKey.read()'), error: new Error('evaluate failed') },
      cleanupReply,
    ],
  });
  const platform = await tvProbe(cdp, { _sleep: noSleep });

  assert.equal(platform.keys.status, 'error');
  assert.match(platform.keys.error, /evaluate failed/);
  assert.match(cdp.sent('Runtime.evaluate').at(-1).params.expression, /removeEventListener/);
});

// Row 15
test('a failing features step cleans up before it propagates', async () => {
  const cdp = stubCdp({
    replies: [
      { match: (e) => e.includes('IntersectionObserver'), error: new Error('runtime gone') },
      cleanupReply,
    ],
  });
  await assert.rejects(tvProbe(cdp, { _sleep: noSleep }), /runtime gone/);
  assert.match(cdp.sent('Runtime.evaluate').at(-1).params.expression, /removeEventListener/);
});

// Row 15
test('a playing video makes the video step inconclusive and is never touched', async () => {
  const cdp = stubCdp({
    replies: [
      featuresReply(),
      registerReply('returned'),
      currentReply('object'),
      { match: (e) => e.includes("querySelectorAll('video')"), value: true },
      installReply,
      readReply([]),
      cleanupReply,
    ],
  });
  const platform = await tvProbe(cdp, { video: 'http://192.0.2.30:8000/clip.mp4', _sleep: noSleep });

  assert.equal(platform.video.status, 'inconclusive');
  const expressions = cdp.sent('Runtime.evaluate').map((call) => call.params.expression);
  assert.equal(expressions.some((e) => e.includes("createElement('video')")), false);
});

// Row 15
test('off the fixture grid the key step dispatches neither Back nor Enter', async () => {
  const cdp = stubCdp({ replies: plainRun() });
  const platform = await tvProbe(cdp, { _sleep: noSleep });

  assert.equal(platform.keys.onFixture, false);
  assert.equal(keyCodes(cdp).includes(10009), false, 'Back must not be sent off the fixture grid');
  assert.equal(keyCodes(cdp).includes(13), false, 'Enter must not be sent off the fixture grid');
  assert.equal(keyCodes(cdp).includes(37), true, 'the arrow keys are still the measurement');
});

// Row 15 — the positive control: the gate is the fixture grid, not an unconditional skip.
test('on the fixture grid the key step dispatches Back and Enter too', async () => {
  const cdp = stubCdp({
    replies: [
      featuresReply(),
      registerReply('returned'),
      currentReply('object'),
      pageReply({ href: 'http://192.0.2.30:8000/tv?tizen=1', origin: 'http://192.0.2.30:8000' }),
      { match: (e) => e.includes('readyState'), value: { href: 'http://127.0.0.1:8001/grid.html', title: 'grid', ready: 'complete' } },
      installReply,
      readReply([]),
      cleanupReply,
    ],
  });
  const platform = await tvProbe(cdp, { navigate: 'http://127.0.0.1:8001/grid.html', _sleep: noSleep });

  assert.equal(platform.navigate.status, 'reached');
  assert.equal(platform.keys.onFixture, true);
  assert.equal(keyCodes(cdp).includes(10009), true);
  assert.equal(keyCodes(cdp).includes(13), true);
});

// Row 15
test('features records registerKey as threw, returned or absent', async () => {
  const threw = stubCdp({
    replies: [
      featuresReply(),
      { match: (e) => e.includes('registerKey'), error: new Error('NotSupportedError') },
      currentReply('object'),
      installReply,
      readReply([]),
      cleanupReply,
    ],
  });
  const threwPlatform = await tvProbe(threw, { _sleep: noSleep });
  assert.equal(threwPlatform.features.registerKey.outcome, 'threw');
  assert.match(threwPlatform.features.registerKey.error, /NotSupportedError/);

  const absent = stubCdp({
    replies: [
      featuresReply({ tvinputdevice: 'undefined', registerKeyPresent: false }),
      currentReply('object'),
      installReply,
      readReply([]),
      cleanupReply,
    ],
  });
  const absentPlatform = await tvProbe(absent, { _sleep: noSleep });
  assert.equal(absentPlatform.features.registerKey.outcome, 'absent');
  assert.equal(absentPlatform.features.registerKey.present, false);
});

// Row 24: step 9 read presence on one document and made the calls on another.
test('every probe step records the page it ran on', async () => {
  const cdp = stubCdp({ replies: [pageReply(), ...plainRun()] });
  const platform = await tvProbe(cdp, { video: 'http://192.0.2.30:8000/clip.mp4', _sleep: noSleep });

  assert.deepEqual(platform.page, PAGE, 'the platform names the page it measured');
  for (const step of ['features', 'navigate', 'video', 'keys', 'listen']) {
    assert.deepEqual(platform[step].page, PAGE, `${step} records the page it ran on`);
  }
});

// Row 24: step 9's probe2 crashed on a document that had no body yet.
test('the feature script measures nothing on a document with no body instead of throwing', () => {
  const element = () => ({
    style: {},
    appendChild() {},
    parentNode: null,
    getBoundingClientRect: () => ({ left: 0, right: 0, height: 0 }),
  });
  const fakeWindow = { tizen: undefined, webapis: undefined };
  const run = new Function('window', 'document', 'navigator', 'getComputedStyle', `return ${FEATURES_JS}`);
  const features = run(fakeWindow, { body: null, createElement: element }, { userAgent: 'stub' }, () => ({}));

  assert.equal(features.tizen, 'undefined');
  assert.equal(features.userAgent, 'stub');
  assert.equal(features.flexGap, false);
  assert.equal(features.aspectRatio, false);
  assert.equal(features.backdropFilter, false);
});

// Row 25
test('the fetch step sends one credentialed GET and records what the page could read', async () => {
  const fetchReply = {
    match: (e) => e.includes("credentials: 'include'"),
    value: {
      httpStatus: 200,
      type: 'cors',
      allowOrigin: 'http://192.0.2.30:8000',
      allowCredentials: 'true',
    },
  };
  const cdp = stubCdp({ replies: [pageReply(), featuresReply(), registerReply('returned'), currentReply('object'), fetchReply, installReply, readReply([]), cleanupReply] });
  const platform = await tvProbe(cdp, { fetch: 'http://127.0.0.1:8001/session', _sleep: noSleep });

  assert.equal(platform.fetch.status, 'measured');
  assert.equal(platform.fetch.httpStatus, 200);
  assert.equal(platform.fetch.allowOrigin, 'http://192.0.2.30:8000');
  assert.equal(platform.fetch.allowCredentials, 'true');
  assert.equal(platform.fetch.url, 'http://127.0.0.1:8001/session');
  assert.deepEqual(platform.fetch.page, PAGE, 'the origin CORS must name is recorded');

  const js = cdp.sent('Runtime.evaluate').map((call) => call.params.expression).find((e) => e.includes("credentials: 'include'"));
  assert.match(js, /method: 'GET'/);
  assert.doesNotMatch(js, /\b(POST|PUT|DELETE|PATCH)\b/, 'one GET, never another method');
});

// Row 25: a rejected fetch has no status to read; the kind of failure is the measurement.
test('a fetch the page cannot make records the failure kind, not a status', async () => {
  const cdp = stubCdp({
    replies: [
      pageReply(),
      featuresReply(),
      registerReply('returned'),
      currentReply('object'),
      { match: (e) => e.includes("credentials: 'include'"), value: { error: 'TypeError', message: 'Failed to fetch' } },
      installReply,
      readReply([]),
      cleanupReply,
    ],
  });
  const platform = await tvProbe(cdp, { fetch: 'http://192.0.2.30:8000/tv/session', _sleep: noSleep });

  assert.equal(platform.fetch.status, 'error');
  assert.equal(platform.fetch.error, 'TypeError');
  assert.match(platform.fetch.message, /Failed to fetch/);
  assert.equal('httpStatus' in platform.fetch, false);
  assert.deepEqual(platform.fetch.page, PAGE);
});

// Row 26
test('the exit step calls exit() last and reports a socket that closed within 3 s', async () => {
  let exited = false;
  let clock = 0;
  const cdp = stubCdp({
    replies: [pageReply(), ...plainRun()],
    onSend: (method, params) => {
      if (method !== 'Runtime.evaluate') return undefined;
      const js = String(params.expression);
      if (js.includes('.exit()')) { exited = true; return 'called'; }
      if (exited && js === '1 + 1') throw new Error('websocket closed');
      return undefined;
    },
  });

  const platform = await tvProbe(cdp, {
    exit: true,
    _sleep: async () => { clock += 100; },
    _now: () => clock,
  });

  assert.equal(platform.exit.status, 'measured');
  assert.equal(platform.exit.closed, true);
  assert.deepEqual(platform.exit.page, PAGE);
  const expressions = cdp.sent('Runtime.evaluate').map((call) => call.params.expression);
  assert.match(expressions.at(-1), /1 \+ 1/, 'exit is the last thing the probe does');
});

// Row 26
test('a socket that stays open past 3 s reports closed false', async () => {
  let clock = 0;
  const cdp = stubCdp({
    replies: [...plainRun()],
    onSend: (method, params) => (method === 'Runtime.evaluate' && String(params.expression).includes('.exit()') ? 'called' : undefined),
  });

  const platform = await tvProbe(cdp, {
    exit: true,
    _sleep: async () => { clock += 250; },
    _now: () => clock,
  });

  assert.equal(platform.exit.closed, false);
  assert.ok(platform.exit.ms >= 3000, `the wait is bounded at 3 s: ${platform.exit.ms} ms`);
});

// Row 26
test('without --exit the probe never calls exit()', async () => {
  const cdp = stubCdp({ replies: plainRun() });
  const platform = await tvProbe(cdp, { _sleep: noSleep });

  assert.equal(platform.exit, null);
  const expressions = cdp.sent('Runtime.evaluate').map((call) => call.params.expression);
  assert.equal(expressions.some((e) => e.includes('.exit()')), false);
});

// Row 16
const HUB_PAGE = { href: 'http://192.0.2.30:8000/tv', origin: 'http://192.0.2.30:8000' };
const LOCAL_PAGE = { href: 'file:///opt/usr/app/index.html', origin: 'null' };
const working = {
  tizen: 'object',
  registerKey: { outcome: 'returned' },
  getCurrentApplication: { outcome: 'returned', returnsObject: true },
};
const platformOn = (page, features, extra = {}) => ({ features: { ...features, page }, ...extra });

test('verdictLine calls a widget-local page with both calls working plan B, its fetch and exit beside it', () => {
  const line = verdictLine(platformOn(LOCAL_PAGE, working, {
    fetch: { status: 'measured', url: 'http://192.168.1.135:8001/session', httpStatus: 200, allowOrigin: 'http://192.168.1.135:8001', allowCredentials: 'true' },
    exit: { status: 'measured', called: 'returned', closed: true, ms: 900 },
  }));

  assert.match(line, /^shell: plan B/);
  assert.match(line, /file:\/\/\/opt\/usr\/app\/index\.html/, 'the line names the page it measured');
  assert.match(line, /--fetch 200/, 'plan B carries the transport evidence beside it');
  assert.match(line, /--exit closed true/, 'plan B carries the exit evidence beside it');
});

test('verdictLine calls a hub page with both calls working plan A and names the page', () => {
  const line = verdictLine(platformOn(HUB_PAGE, working));
  assert.match(line, /^shell: plan A/);
  assert.match(line, /http:\/\/192\.0\.2\.30:8000\/tv/);
});

// torrent-hub-7c's bar: presence is NOT enough — a page that has tizen but whose calls threw is
// neither plan, whatever the widget's shape.
test('verdictLine never calls presence without working calls plan A or B', () => {
  const hub = verdictLine(platformOn(HUB_PAGE, {
    ...working,
    registerKey: { outcome: 'threw', error: 'NotSupportedError' },
  }));
  assert.match(hub, /^shell: no tizen/);
  assert.match(hub, /registerKey\("1"\) threw \(NotSupportedError\)/);
  assert.match(hub, /http:\/\/192\.0\.2\.30:8000\/tv/, 'the line still names the page it measured');

  const local = verdictLine(platformOn(LOCAL_PAGE, {
    ...working,
    getCurrentApplication: { outcome: 'absent' },
  }));
  assert.match(local, /^shell: no tizen/);
  assert.doesNotMatch(local, /^shell: plan B/);

  const bare = verdictLine(platformOn(HUB_PAGE, { tizen: 'undefined' }));
  assert.match(bare, /^shell: no tizen/);
  assert.match(bare, /typeof tizen is "undefined"/);
});

test('verdictLine leaves an unread page undetermined rather than guessing a plan', () => {
  const line = verdictLine(platformOn({ href: null, origin: null }, working));
  assert.match(line, /^shell: undetermined/);
  assert.doesNotMatch(line, /^shell: plan/);
});

test('platformPath puts the platform file under the temp ui-probe directory', () => {
  assert.equal(platformPath('torrenthub.main'), join(tmpdir(), 'ui-probe', 'platform-torrenthub.main.json'));
});

test('platformSummary keeps the verdict and the evidence a reader acts on', () => {
  const summary = platformSummary({
    generatedAt: '2026-11-13T00:00:00.000Z',
    features: { ...working, page: HUB_PAGE },
  });
  assert.equal(summary.generatedAt, '2026-11-13T00:00:00.000Z');
  assert.match(summary.verdict, /^shell: plan A/);
  assert.equal(summary.registerKey, 'returned');
});

