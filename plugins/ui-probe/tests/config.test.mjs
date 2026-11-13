import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { findConfig, loadConfig, ConfigError, BUILTIN_VIEWPORTS } from '../src/config.mjs';

function tmpCase(t, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'ui-probe-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, '.ui-probe.json');
  writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return file;
}

function loadError(t, contents) {
  try {
    loadConfig(tmpCase(t, contents));
  } catch (e) {
    assert.ok(e instanceof ConfigError, `expected ConfigError, got ${e}`);
    return e;
  }
  assert.fail('expected loadConfig to throw');
}

const FULL = {
  baseUrl: 'http://127.0.0.1:8001',
  viewports: { handset: { width: 360, height: 640, dpr: 2, touch: true } },
  screens: {
    home: { url: '/home', steps: [{ open: { url: '/home' } }], measure: ['[data-testid=tile]'] },
  },
  auth: { cookies: [{ name: 'session', command: ['get-cookie', '--token', '{TOKEN}'], domain: '127.0.0.1' }] },
  outDir: 'C:\\tmp\\out',
  browser: 'C:\\Program Files\\Edge\\msedge.exe',
};

test('accepts every key in the Config table, screens with url/steps/measure included', (t) => {
  const config = loadConfig(tmpCase(t, FULL));
  assert.equal(config.baseUrl, FULL.baseUrl);
  assert.equal(config.viewports.handset.width, 360);
  assert.equal(config.viewports.handset.touch, true);
  assert.deepEqual(config.screens.home.measure, ['[data-testid=tile]']);
  assert.equal(config.screens.home.steps.length, 1);
  assert.equal(config.auth.cookies[0].command[0], 'get-cookie');
  assert.equal(config.outDir, FULL.outDir);
  assert.equal(config.browser, FULL.browser);
});

test('built-in phone and desktop viewports are present alongside user viewports', (t) => {
  const config = loadConfig(tmpCase(t, FULL));
  assert.deepEqual(config.viewports.phone, BUILTIN_VIEWPORTS.phone);
  assert.deepEqual(config.viewports.desktop, BUILTIN_VIEWPORTS.desktop);
});

test('minimal config: only baseUrl is required; outDir defaults under the os tmpdir', (t) => {
  const config = loadConfig(tmpCase(t, { baseUrl: 'http://127.0.0.1:8001' }));
  assert.ok(config.outDir.startsWith(tmpdir()));
  assert.equal(config.browser, undefined);
  assert.deepEqual(config.viewports.phone, BUILTIN_VIEWPORTS.phone);
});

test('rejects an unknown top-level key, naming it, with fix and example', (t) => {
  const err = loadError(t, { baseUrl: 'http://x.test', bogus: 1 });
  const e = err.errors.find((e) => e.field === 'bogus');
  assert.ok(e, 'expected an error for "bogus"');
  assert.equal(typeof e.problem, 'string');
  assert.equal(typeof e.fix, 'string');
  assert.equal(typeof e.example, 'string');
});

test('rejects a non-positive viewport width and height', (t) => {
  const err = loadError(t, { baseUrl: 'http://x.test', viewports: { small: { width: 0, height: -5 } } });
  const fields = err.errors.map((e) => e.field);
  assert.ok(fields.includes('viewports.small.width'));
  assert.ok(fields.includes('viewports.small.height'));
});

test('rejects a screen without url', (t) => {
  const err = loadError(t, { baseUrl: 'http://x.test', screens: { home: { measure: ['#a'] } } });
  assert.ok(err.errors.some((e) => e.field === 'screens.home.url'));
});

test('rejects a non-array cookie command', (t) => {
  const err = loadError(t, { baseUrl: 'http://x.test', auth: { cookies: [{ name: 's', command: 'get-cookie' }] } });
  assert.ok(err.errors.some((e) => e.field === 'auth.cookies[0].command'));
});

test('rejects missing baseUrl', (t) => {
  const err = loadError(t, {});
  assert.ok(err.errors.some((e) => e.field === 'baseUrl'));
});

test('rejects a non-http baseUrl', (t) => {
  const err = loadError(t, { baseUrl: 'ftp://x.test' });
  assert.ok(err.errors.some((e) => e.field === 'baseUrl'));
});

test('rejects invalid JSON with a ConfigError', (t) => {
  assert.throws(() => loadConfig(tmpCase(t, '{ not json')), ConfigError);
});

test('rejects a missing file with a ConfigError', (t) => {
  assert.throws(() => loadConfig(join(tmpdir(), 'ui-probe-no-such-file-9f3a2.json')), ConfigError);
});

test('rejects unknown keys inside a screen', (t) => {
  const err = loadError(t, { baseUrl: 'http://x.test', screens: { home: { url: '/', bogus: 1 } } });
  assert.ok(err.errors.some((e) => e.field === 'screens.home.bogus'));
});

test('rejects non-array screen steps and measure entries that are not strings', (t) => {
  const err = loadError(t, { baseUrl: 'http://x.test', screens: { s: { url: '/', steps: 'nope', measure: [42] } } });
  assert.ok(err.errors.some((e) => e.field === 'screens.s.steps'));
  assert.ok(err.errors.some((e) => e.field === 'screens.s.measure[0]'));
});

test('rejects a cookie without a name and a non-boolean touch', (t) => {
  const err = loadError(t, {
    baseUrl: 'http://x.test',
    viewports: { v: { width: 100, height: 100, touch: 'yes' } },
    auth: { cookies: [{ command: ['x'] }] },
  });
  assert.ok(err.errors.some((e) => e.field === 'auth.cookies[0].name'));
  assert.ok(err.errors.some((e) => e.field === 'viewports.v.touch'));
});

test('findConfig walks up from a nested directory', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-probe-find-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '.ui-probe.json'), JSON.stringify({ baseUrl: 'http://x.test' }));
  const nested = join(dir, 'a', 'b');
  mkdirSync(nested, { recursive: true });
  assert.equal(findConfig(nested), join(dir, '.ui-probe.json'));
});

test('loadConfig exposes the config directory for the auth spawn cwd', (t) => {
  const file = tmpCase(t, { baseUrl: 'http://x.test' });
  const config = loadConfig(file);
  assert.equal(config.configDir, dirname(file));
  assert.ok(!Object.keys(config).includes('configDir'), 'configDir stays non-enumerable');
});

// --- tv block ---

const TV_FULL = { host: '192.0.2.10:26101', appid: 'torrenthub.main', sdb: 'C:\tizen\sdb.exe', testOrigin: 'http://192.0.2.20:8001', focusSelector: '.tile.focused' };

test('accepts a full tv block and keeps the given focusSelector', (t) => {
  const config = loadConfig(tmpCase(t, { baseUrl: 'http://x.test', tv: TV_FULL }));
  assert.equal(config.tv.host, '192.0.2.10:26101');
  assert.equal(config.tv.appid, 'torrenthub.main');
  assert.equal(config.tv.sdb, TV_FULL.sdb);
  assert.equal(config.tv.testOrigin, 'http://192.0.2.20:8001');
  assert.equal(config.tv.focusSelector, '.tile.focused');
});

test('focusSelector defaults to .focused when the tv block omits it', (t) => {
  const config = loadConfig(tmpCase(t, { baseUrl: 'http://x.test', tv: { host: '192.0.2.10:26101', appid: 'torrenthub.main' } }));
  assert.equal(config.tv.focusSelector, '.focused');
});

test('a config with no tv block is still valid and has no tv key', (t) => {
  const config = loadConfig(tmpCase(t, { baseUrl: 'http://x.test' }));
  assert.equal(config.tv, undefined);
});

test('rejects a tv block that is not an object', (t) => {
  for (const bad of ['tv', 42, []]) {
    const err = loadError(t, { baseUrl: 'http://x.test', tv: bad });
    assert.ok(err.errors.some((e) => e.field === 'tv'), `expected a tv error for ${JSON.stringify(bad)}`);
  }
});

test('rejects a tv.host without a port, with a non-numeric port, and out of range', (t) => {
  for (const host of ['192.0.2.10', '192.0.2.10:abc', '192.0.2.10:99999', '192.0.2.10:0', 'http://192.0.2.10:26101', '']) {
    const err = loadError(t, { baseUrl: 'http://x.test', tv: { host, appid: 'torrenthub.main' } });
    assert.ok(err.errors.some((e) => e.field === 'tv.host'), `expected tv.host error for ${JSON.stringify(host)}`);
  }
});

test('rejects a missing or malformed tv.appid', (t) => {
  for (const appid of [undefined, '', '   ', 'has space', 'a/b', 42]) {
    const tv = { host: '192.0.2.10:26101' };
    if (appid !== undefined) tv.appid = appid;
    const err = loadError(t, { baseUrl: 'http://x.test', tv });
    assert.ok(err.errors.some((e) => e.field === 'tv.appid'), `expected tv.appid error for ${JSON.stringify(appid)}`);
  }
});

test('rejects an empty tv.sdb and a non-string tv.sdb', (t) => {
  for (const sdb of ['', '   ', 42]) {
    const err = loadError(t, { baseUrl: 'http://x.test', tv: { host: '192.0.2.10:26101', appid: 'torrenthub.main', sdb } });
    assert.ok(err.errors.some((e) => e.field === 'tv.sdb'), `expected tv.sdb error for ${JSON.stringify(sdb)}`);
  }
});

test('rejects a tv.testOrigin that is not an http(s) origin', (t) => {
  for (const testOrigin of ['ftp://192.0.2.20:8001', 'not a url', 'http://192.0.2.20:8001/path', 'http://192.0.2.20:8001/?q=1', 'file:///tmp/x']) {
    const err = loadError(t, { baseUrl: 'http://x.test', tv: { host: '192.0.2.10:26101', appid: 'torrenthub.main', testOrigin } });
    assert.ok(err.errors.some((e) => e.field === 'tv.testOrigin'), `expected tv.testOrigin error for ${JSON.stringify(testOrigin)}`);
  }
});

test('accepts http and https tv.testOrigin with and without a trailing slash', (t) => {
  for (const testOrigin of ['http://192.0.2.20:8001', 'https://tv.example.com', 'http://192.0.2.20:8001/']) {
    const config = loadConfig(tmpCase(t, { baseUrl: 'http://x.test', tv: { host: '192.0.2.10:26101', appid: 'torrenthub.main', testOrigin } }));
    assert.equal(config.tv.testOrigin, testOrigin);
  }
});

test('rejects an empty tv.focusSelector and a non-string one', (t) => {
  for (const focusSelector of ['', '   ', 42]) {
    const err = loadError(t, { baseUrl: 'http://x.test', tv: { host: '192.0.2.10:26101', appid: 'torrenthub.main', focusSelector } });
    assert.ok(err.errors.some((e) => e.field === 'tv.focusSelector'), `expected tv.focusSelector error for ${JSON.stringify(focusSelector)}`);
  }
});

test('rejects unknown keys inside tv, naming the key', (t) => {
  const err = loadError(t, { baseUrl: 'http://x.test', tv: { host: '192.0.2.10:26101', appid: 'torrenthub.main', bogus: 1 } });
  assert.ok(err.errors.some((e) => e.field === 'tv.bogus'));
});

test('tv errors carry fix and example like the rest of the teaching errors', (t) => {
  const err = loadError(t, { baseUrl: 'http://x.test', tv: { host: 'nope' } });
  for (const e of err.errors) {
    assert.equal(typeof e.problem, 'string');
    assert.equal(typeof e.fix, 'string');
    assert.equal(typeof e.example, 'string');
  }
});
