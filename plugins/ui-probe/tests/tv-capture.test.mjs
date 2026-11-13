// TV capture rows: what a capture on the set records, and the screenshot replay it may run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { capture } from '../src/capture.mjs';
import { platformPath } from '../src/tv/probe.mjs';
import { TV_PROTOCOL, noSleep, stubCdp } from './tv-support.mjs';

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

test('capture on the TV with an unreadable protocol writes its outputs and installs no interception', async () => {
  const run = await captureTv({ ctx: { protocol: null } });
  try {
    for (const name of ['dom.html', 'observation.txt', 'network.json']) {
      assert.equal(existsSync(join(run.out, name)), true, `${name} is written`);
    }
    assert.equal(run.cdp.sent('Fetch.enable').length, 0, 'no Fetch on a target that served no protocol');
    assert.equal(run.cdp.sent('Network.setRequestInterception').length, 0);
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});

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
