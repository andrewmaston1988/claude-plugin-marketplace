import { test } from 'node:test';
import assert from 'node:assert/strict';
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
