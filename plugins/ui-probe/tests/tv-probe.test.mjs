import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { FEATURES_JS, platformPath, platformSummary, tvProbe, verdictLine } from '../src/tv/probe.mjs';
import { capture } from '../src/capture.mjs';

// The set's 39-domain protocol: Network interception exists, Fetch does not.
const TV_PROTOCOL = {
  domains: [
    { domain: 'Input', commands: [{ name: 'dispatchKeyEvent' }] },
    { domain: 'Network', commands: [{ name: 'enable' }, { name: 'setRequestInterception' }, { name: 'continueInterceptedRequest' }] },
  ],
};

const noSleep = async () => {};

function stubCdp({ replies = [], onSend = null } = {}) {
  const calls = [];
  const handlers = new Map();
  const queue = replies.map((reply) => ({ ...reply, used: false }));
  const api = {
    calls,
    methods: () => calls.map((call) => call.method),
    sent: (method) => calls.filter((call) => call.method === method),
    on(method, fn) {
      handlers.set(method, [...(handlers.get(method) || []), fn]);
      return () => handlers.set(method, (handlers.get(method) || []).filter((f) => f !== fn));
    },
    async fire(method, params) {
      for (const fn of handlers.get(method) || []) await fn(params);
    },
    async send(method, params = {}) {
      calls.push({ method, params });
      if (onSend) {
        const custom = onSend(method, params, api);
        if (custom !== undefined) return custom;
      }
      if (method === 'Runtime.evaluate') {
        const reply = queue.find((entry) => !entry.used && entry.match(params.expression));
        if (!reply) return { result: { value: null } };
        if (!reply.sticky) reply.used = true;
        if (reply.error) throw reply.error;
        return { result: { value: reply.value } };
      }
      return {};
    },
  };
  return api;
}

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

// Row 16
test('verdictLine names plan A, plan B and no tizen from the platform evidence', () => {
  const platform = (features) => ({ features });

  assert.match(verdictLine(platform({
    tizen: 'object',
    registerKey: { outcome: 'returned' },
    getCurrentApplication: { outcome: 'returned', returnsObject: true },
  })), /^shell: plan A/);

  assert.match(verdictLine(platform({
    tizen: 'object',
    registerKey: { outcome: 'returned' },
    getCurrentApplication: { outcome: 'absent' },
  })), /^shell: plan B/);

  assert.match(verdictLine(platform({
    tizen: 'object',
    registerKey: { outcome: 'threw', error: 'NotSupportedError' },
    getCurrentApplication: { outcome: 'returned', returnsObject: true },
  })), /^shell: plan B/);

  assert.match(verdictLine(platform({ tizen: 'undefined' })), /^shell: no tizen/);
});

test('platformPath puts the platform file under the temp ui-probe directory', () => {
  assert.equal(platformPath('torrenthub.main'), join(tmpdir(), 'ui-probe', 'platform-torrenthub.main.json'));
});

test('platformSummary keeps the verdict and the evidence a reader acts on', () => {
  const summary = platformSummary({
    generatedAt: '2026-11-13T00:00:00.000Z',
    features: { tizen: 'object', registerKey: { outcome: 'returned' }, getCurrentApplication: { outcome: 'returned', returnsObject: true } },
  });
  assert.equal(summary.generatedAt, '2026-11-13T00:00:00.000Z');
  assert.match(summary.verdict, /^shell: plan A/);
  assert.equal(summary.registerKey, 'returned');
});

const tvConfig = (appid) => ({
  baseUrl: 'http://192.0.2.30:8000',
  outDir: 'out',
  configDir: 'C:\\cfg',
  viewports: {},
  tv: { host: '192.0.2.10:26101', appid, focusSelector: '.focused', testOrigin: 'http://127.0.0.1:8001' },
});

const captureReplies = () => [
  { match: (e) => e.includes('outerHTML'), value: '<html></html>' },
  { match: (e) => e.includes('matchMedia'), value: { hover_none: true, pointer_coarse: true, innerWidth: 1920, innerHeight: 1080, dpr: 1, ua: 'TV' } },
  { match: (e) => e.trim() === 'location.href', value: 'http://192.0.2.30:8000/tv?tizen=1' },
  { match: (e) => e.includes('SKIP'), value: 'body [focused]' },
];

const LAYERS = [
  { layerId: '1', parentLayerId: null, offsetX: 0, offsetY: 0, width: 1920, height: 1080, drawsContent: false, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  { layerId: '2', parentLayerId: '1', offsetX: 10, offsetY: 20, width: 600, height: 400, drawsContent: true, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1] },
  { layerId: '3', parentLayerId: '1', offsetX: 0, offsetY: 60, width: 1920, height: 2000, drawsContent: true, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
];

const layerOnSend = (layers = LAYERS) => (method, params, api) => {
  if (method === 'LayerTree.enable') {
    api.fire('LayerTree.layerTreeDidChange', { layers });
    return {};
  }
  if (method === 'LayerTree.makeSnapshot') return { snapshotId: `snap-${params.layerId}` };
  if (method === 'LayerTree.replaySnapshot') return { dataURL: 'data:image/png;base64,QUJD' };
  return undefined;
};

const compositeReply = { match: (e) => e.includes('createImageBitmap'), value: { dataUrl: 'data:image/png;base64,REVG', drawn: 2, width: 960, height: 540 } };

function tvCaptureCdp({ replies = captureReplies(), onSend = layerOnSend() } = {}) {
  return stubCdp({ replies: [...replies, compositeReply], onSend });
}

async function captureTv(overrides = {}) {
  const appid = overrides.appid ?? `uiprobe.capture${process.pid}`;
  const dir = mkdtempSync(join(tmpdir(), 'ui-probe-tv-capture-'));
  const cdp = overrides.cdp ?? tvCaptureCdp();
  try {
    const result = await capture(
      overrides.screen ?? { url: '/tv' },
      {
        config: tvConfig(appid),
        cdp,
        outDir: dir,
        device: 'tv',
        protocol: TV_PROTOCOL,
        _sleep: noSleep,
        ...(overrides.ctx ?? {}),
      },
    );
    return { cdp, dir, result, out: join(dir, 'tv') };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

const readEnv = (out) => JSON.parse(readFileSync(join(out, 'env.json'), 'utf8'));

// Row 17
test('capture on the TV writes the platform.json summary into env.json when the file exists', async () => {
  const appid = `uiprobe.summary${process.pid}`;
  const file = platformPath(appid);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    generatedAt: '2026-11-13T00:00:00.000Z',
    verdict: 'shell: plan A — evidence',
    features: { tizen: 'object', registerKey: { outcome: 'returned' }, getCurrentApplication: { outcome: 'returned', returnsObject: true } },
  }));
  const run = await captureTv({ appid });
  try {
    const env = readEnv(run.out);
    assert.equal(env.platform.verdict, 'shell: plan A — evidence');
    assert.equal(env.platform.generatedAt, '2026-11-13T00:00:00.000Z');
    assert.equal(env.url, 'http://192.0.2.30:8000/tv?tizen=1');
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
    rmSync(file, { force: true });
  }
});

// Row 22
test('capture on the TV writes the attach timings into env.json', async () => {
  const timings = { attachMs: 4200, relaunchMs: 3800 };
  const run = await captureTv({ ctx: { timings } });
  try {
    assert.deepEqual(readEnv(run.out).timings, timings);
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});

// Row 17
test('capture on the TV leaves platform out of env.json when platform.json is absent', async () => {
  const appid = `uiprobe.noplatform${process.pid}`;
  const run = await captureTv({ appid });
  try {
    const env = readEnv(run.out);
    assert.equal('platform' in env, false);
    assert.equal(env.url, 'http://192.0.2.30:8000/tv?tizen=1');
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});

// Row 17
test('capture on the TV never screenshots, never screencasts and never runs the probe', async () => {
  const run = await captureTv();
  try {
    const methods = run.cdp.methods();
    assert.equal(methods.includes('Page.captureScreenshot'), false);
    assert.equal(methods.includes('Page.startScreencast'), false);
    assert.equal(methods.includes('Page.navigate'), false, 'the attached app is already on its page');
    const expressions = run.cdp.sent('Runtime.evaluate').map((call) => call.params.expression);
    assert.equal(expressions.some((e) => e.includes('registerKey')), false);
    assert.equal(expressions.some((e) => e.includes('IntersectionObserver')), false);

    const guard = run.cdp.sent('Network.setRequestInterception');
    assert.equal(guard.length, 2, 'the M69 Network guard is installed and uninstalled');
    assert.equal(run.cdp.sent('Fetch.enable').length, 0);
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});

// Row 17
test('without --screenshot capture sends no LayerTree call and writes no screenshot.png', async () => {
  const run = await captureTv();
  try {
    assert.equal(run.cdp.methods().some((method) => method.startsWith('LayerTree.')), false);
    assert.equal(existsSync(join(run.out, 'screenshot.png')), false);
    assert.equal(readEnv(run.out).screenshot.status, 'skipped');
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});

// Row 17
test('with --screenshot capture replays every painting layer at half scale and composites in-page', async () => {
  const run = await captureTv({ ctx: { screenshot: true } });
  try {
    const snapshots = run.cdp.sent('LayerTree.makeSnapshot').map((call) => call.params.layerId);
    assert.deepEqual(snapshots, ['2', '3']);
    const replays = run.cdp.sent('LayerTree.replaySnapshot');
    assert.equal(replays.length, 2);
    for (const call of replays) assert.equal(call.params.scale, 0.5);

    const composite = run.cdp.sent('Runtime.evaluate').find((call) => call.params.expression.includes('createImageBitmap'));
    assert.ok(composite, 'the layers are composited in the page');
    const js = composite.params.expression;
    assert.match(js, /new Blob/);
    assert.match(js, /toDataURL/);
    assert.match(js, /drawImage/);
    assert.match(js, /scrollX/);
    assert.match(js, /"offsetX":10/);
    assert.match(js, /"transform":\[1,0,0,0,0,1,0,0,0,0,1,0,5,6,0,1\]/);
    assert.doesNotMatch(js, /new Image\(/);
    assert.doesNotMatch(js, /\.src\s*=/);

    const env = readEnv(run.out);
    assert.equal(env.screenshot.status, 'written');
    assert.equal(env.screenshot.layers, 3);
    assert.equal(env.screenshot.drawn, 2);
    assert.equal(typeof env.screenshot.ms, 'number');
    assert.equal(readFileSync(join(run.out, 'screenshot.png')).toString('base64'), 'REVG');
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});

// Row 17
test('a replay that overruns its bound leaves no screenshot.png and says why in env.json', async () => {
  const cdp = tvCaptureCdp({
    onSend: (method, params, api) => {
      if (method === 'LayerTree.enable') {
        api.fire('LayerTree.layerTreeDidChange', { layers: LAYERS });
        return {};
      }
      if (method === 'LayerTree.makeSnapshot') return { snapshotId: 'snap-1' };
      if (method === 'LayerTree.replaySnapshot') return new Promise(() => {});
      return undefined;
    },
  });
  const run = await captureTv({ cdp, ctx: { screenshot: true, _replayTimeoutMs: 25 } });
  try {
    assert.equal(existsSync(join(run.out, 'screenshot.png')), false);
    const env = readEnv(run.out);
    assert.equal(env.screenshot.status, 'timeout');
    assert.match(env.screenshot.reason, /exceeded 25 ms/);
    assert.equal(env.screenshot.layers, 3);
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});
