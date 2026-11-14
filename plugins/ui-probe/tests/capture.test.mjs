import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { capture } from '../src/capture.mjs';
import { AuthError } from '../src/auth.mjs';

function stubCdp() {
  const sent = [];
  let onCount = 0;
  let offCount = 0;
  const handlers = new Map();
  return {
    sent,
    onCount: () => onCount,
    offCount: () => offCount,
    on(event, cb) {
      onCount += 1;
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(cb);
      return () => { offCount += 1; };
    },
    async send(method, params) {
      sent.push({ method, params });
      return {};
    },
  };
}

const config = {
  baseUrl: 'http://127.0.0.1:1',
  outDir: 'out',
  configDir: 'C:\\cfg',
  viewports: { phone: { width: 390, height: 844 } },
  auth: { cookies: [{ name: 'session', command: ['get-cookie', '--token', '{MISSING_VAR}'] }] },
};

// A capture's recorder is the one the run inside it uses, so the page is enabled once.
function captureCdp() {
  const sent = [];
  const handlers = new Map();
  let onCount = 0;
  let offCount = 0;
  return {
    sent,
    onCount: () => onCount,
    offCount: () => offCount,
    count: (method) => sent.filter((call) => call.method === method).length,
    on(event, cb) {
      onCount += 1;
      handlers.set(event, [...(handlers.get(event) || []), cb]);
      return () => { offCount += 1; };
    },
    async send(method, params = {}) {
      sent.push({ method, params });
      if (method === 'Page.navigate') {
        for (const fn of handlers.get('Page.loadEventFired') || []) fn({});
        return {};
      }
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression);
        if (expression.includes('textContent')) return { result: { value: { found: true, value: 'hello' } } };
        if (expression.includes('matchMedia')) {
          return { result: { value: { hover_none: false, pointer_coarse: false, innerWidth: 390, innerHeight: 844, dpr: 1, ua: 'stub' } } };
        }
        if (expression.includes('outerHTML')) return { result: { value: '<html></html>' } };
        return { result: { value: null } };
      }
      if (method === 'Page.captureScreenshot') return { data: 'QUJD' };
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
      return {};
    },
  };
}

test('row 6: a desktop capture hands its recorder to run, so Runtime.enable is sent once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-probe-capture-evidence-'));
  const cdp = captureCdp();
  try {
    await capture(
      { url: '/', steps: [{ expect_text: { target: 'h1', equals: 'hello' } }] },
      {
        config: { baseUrl: 'http://127.0.0.1:1', configDir: dir, viewports: { phone: { width: 390, height: 844 } } },
        cdp,
        viewports: ['phone'],
        outDir: dir,
      },
    );
    assert.equal(cdp.count('Runtime.enable'), 1, cdp.sent.map((call) => call.method).join(','));
    assert.equal(cdp.onCount(), cdp.offCount(), 'every listener installed is uninstalled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an AuthError inside capture() uninstalls every listener and the Fetch guard', async () => {
  const cdp = stubCdp();
  const screen = { url: '/', name: 'home' };
  await assert.rejects(
    capture(screen, { config, cdp, vars: {}, viewports: ['phone'], outDir: 'out' }),
    (err) => err instanceof AuthError && /MISSING_VAR/.test(err.message),
  );
  assert.equal(cdp.onCount(), cdp.offCount(), 'every listener installed must be uninstalled');
  assert.ok(cdp.sent.some((m) => m.method === 'Fetch.enable'), 'guard was enabled');
  assert.ok(cdp.sent.some((m) => m.method === 'Fetch.disable'), 'guard is disabled on the way out');
});
