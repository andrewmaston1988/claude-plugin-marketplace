import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPaths } from '../src/paths.mjs';
import { loadConfig, DEFAULTS } from '../src/config.mjs';

test('getPaths returns the four dirs, all scoped to claude-peers', () => {
  const p = getPaths();
  for (const key of ['configDir', 'dataDir', 'stateDir', 'logDir']) {
    assert.equal(typeof p[key], 'string');
    assert.match(p[key], /claude-peers/);
  }
});

test('loadConfig: defaults when no file and no env', () => {
  const paths = { configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'peers-cfg-')) };
  assert.deepEqual(loadConfig({ _env: {}, paths }), DEFAULTS);
  assert.equal(DEFAULTS.port, 7899);
  assert.equal(DEFAULTS.pollIntervalMs, 1000);
  assert.equal(DEFAULTS.heartbeatIntervalMs, 15000);
});

test('loadConfig: config.json overrides defaults; env overrides config.json', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peers-cfg-'));
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ port: 8001, pollIntervalMs: 250 }));
  const fromFile = loadConfig({ _env: {}, paths: { configDir } });
  assert.equal(fromFile.port, 8001);
  assert.equal(fromFile.pollIntervalMs, 250);
  const fromEnv = loadConfig({ _env: { CLAUDE_PEERS_PORT: '9002' }, paths: { configDir } });
  assert.equal(fromEnv.port, 9002);
});

test('loadConfig: corrupt config.json fails loudly', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peers-cfg-'));
  fs.writeFileSync(path.join(configDir, 'config.json'), '{ nope');
  assert.throws(() => loadConfig({ _env: {}, paths: { configDir } }));
});
