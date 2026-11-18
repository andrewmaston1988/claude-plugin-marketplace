// The temp layout: one root, one run-directory shape, and a bounded prune. Every row keeps
// the plugin's own fixtures out of the operator's real temp.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from '../src/browser.mjs';
import { loadConfig } from '../src/config.mjs';
import { PROFILE_PREFIX, isUiProbeProfile, preScanProfiles, writeOwnerFile } from '../src/reaper.mjs';
import {
  defaultRunDir, platformPath, profilesDir, pruneRuns, resolveOutDir, runsDir, uiProbeTemp,
} from '../src/temp-paths.mjs';

const ISO_NAME = /^\d{4}-\d{2}-\d{2}T[\d-]+Z$/;
const HOUR = 60 * 60 * 1000;
const OLD = 72 * HOUR;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ui-probe-paths-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRun(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'results.json'), '[]');
}

function age(path, msAgo) {
  const seconds = (Date.now() - msAgo) / 1000;
  utimesSync(path, seconds, seconds);
}

const pad = (n) => String(n).padStart(2, '0');

// A1 ---------------------------------------------------------------------------

test('A1: every ui-probe temp path sits under <tmpdir>/ui-probe', (t) => {
  const root = fixture(t);
  const opts = { _tmpdir: () => root, env: {} };
  const base = join(root, 'ui-probe');
  assert.equal(runsDir(opts), join(base, 'runs'));
  assert.equal(profilesDir(opts), join(base, 'profiles'));
  assert.equal(platformPath('x', opts), join(base, 'platform-x.json'));
  const run = defaultRunDir(opts);
  assert.equal(join(run, '..'), join(base, 'runs'));
  assert.match(run.slice(base.length + 6), ISO_NAME);
});

test('A1: UI_PROBE_TEMP moves the whole layout', (t) => {
  const root = fixture(t);
  const opts = { _tmpdir: () => root, env: { UI_PROBE_TEMP: join(root, 'elsewhere') } };
  assert.equal(uiProbeTemp(opts), join(root, 'elsewhere'));
  assert.equal(runsDir(opts), join(root, 'elsewhere', 'runs'));
  assert.equal(profilesDir(opts), join(root, 'elsewhere', 'profiles'));
});

test('A1: a launch mints its profile folder under profilesDir()', async (t) => {
  const root = fixture(t);
  const previous = process.env.UI_PROBE_TEMP;
  process.env.UI_PROBE_TEMP = join(root, 'temp');
  t.after(() => {
    if (previous === undefined) delete process.env.UI_PROBE_TEMP;
    else process.env.UI_PROBE_TEMP = previous;
  });
  const minted = [];
  const fs = {
    existsSync: () => true,
    mkdtempSync: (prefix) => {
      minted.push(prefix);
      throw new Error('mint recorded');
    },
  };
  await assert.rejects(
    launch({ browser: 'C:/browsers/msedge.exe', _fs: fs, _reap: async () => ({}), _spawn: () => ({ exitCode: null }) }),
    /mint recorded/,
  );
  assert.deepEqual(minted, [join(profilesDir(), PROFILE_PREFIX)]);
});

// A2 ---------------------------------------------------------------------------

test('A2: both outDir defaults give runs/<ISO stamp>', (t) => {
  const root = fixture(t);
  const configDir = join(root, 'config');
  mkdirSync(configDir);
  const file = join(configDir, '.ui-probe.json');
  writeFileSync(file, JSON.stringify({ baseUrl: 'http://127.0.0.1:9' }));

  const config = loadConfig(file);
  const expected = join(uiProbeTemp(), 'runs');
  assert.equal(join(config.outDir, '..'), expected);
  assert.match(config.outDir.slice(expected.length + 1), ISO_NAME);
  assert.equal(config.outDirDefaulted, true, 'the run command can tell it owns the path');
  assert.equal(Object.keys(config).includes('outDirDefaulted'), false, 'the config keeps its documented keys');

  const resolved = resolveOutDir(undefined, undefined, { _tmpdir: () => root, env: {} });
  const runs = join(root, 'ui-probe', 'runs');
  assert.equal(join(resolved, '..'), runs);
  assert.match(resolved.slice(runs.length + 1), ISO_NAME);
});

test('A2: a config outDir and --out both win over the default', (t) => {
  const root = fixture(t);
  const opts = { _tmpdir: () => root, env: {} };
  assert.equal(resolveOutDir({ outDir: 'D:/mine' }, undefined, opts), 'D:/mine');
  assert.equal(resolveOutDir({ outDir: 'D:/mine' }, 'D:/flag', opts), 'D:/flag');
  assert.equal(resolveOutDir(undefined, 'D:/flag', opts), 'D:/flag');
});

// A3 ---------------------------------------------------------------------------

test('A3: pruning keeps the newest 20 and anything under 24 h, legacy names included', (t) => {
  const root = fixture(t);
  const env = { UI_PROBE_TEMP: join(root, 'ui-probe') };
  const opts = { _tmpdir: () => root, env };
  const runs = runsDir(opts);
  const base = join(root, 'ui-probe');

  // Contents first, mtimes last: writing a child moves its parent's mtime.
  for (let i = 0; i < 22; i++) makeRun(join(runs, `fresh-${pad(i)}`));
  for (let i = 0; i < 6; i++) makeRun(join(runs, `old-${pad(i)}`));
  makeRun(join(base, '2026-11-01T00-00-00-000Z'));
  makeRun(join(base, '1700000000000'));
  writeFileSync(join(base, 'platform-x.json'), '{}');

  for (let i = 0; i < 22; i++) age(join(runs, `fresh-${pad(i)}`), HOUR);
  for (let i = 0; i < 6; i++) age(join(runs, `old-${pad(i)}`), OLD);
  age(join(base, '2026-11-01T00-00-00-000Z'), OLD);
  age(join(base, '1700000000000'), OLD);

  assert.equal(pruneRuns({ ...opts, now: () => Date.now() }), 8);
  for (let i = 0; i < 22; i++) {
    assert.ok(existsSync(join(runs, `fresh-${pad(i)}`)), `fresh-${pad(i)} survives: under 24 h, past the keep window`);
  }
  for (let i = 0; i < 6; i++) {
    assert.equal(existsSync(join(runs, `old-${pad(i)}`)), false, `old-${pad(i)} is pruned`);
  }
  assert.equal(existsSync(join(base, '2026-11-01T00-00-00-000Z')), false, 'the legacy ISO run is pruned');
  assert.equal(existsSync(join(base, '1700000000000')), false, 'the legacy Date.now() run is pruned');
  assert.ok(existsSync(join(base, 'platform-x.json')), 'the platform cache is not a run');
});

test('A3: the newest 20 survive, and one run deletes at most 200 folders', (t) => {
  const root = fixture(t);
  const env = { UI_PROBE_TEMP: join(root, 'ui-probe') };
  const opts = { _tmpdir: () => root, env };
  const runs = runsDir(opts);

  for (let i = 0; i < 280; i++) makeRun(join(runs, `bulk-${i}`));
  for (let i = 0; i < 20; i++) makeRun(join(runs, `newest-${pad(i)}`));
  // The newest 20 are old too, so only the keep window protects them.
  for (let i = 0; i < 280; i++) age(join(runs, `bulk-${i}`), OLD + 1000 + i);
  for (let i = 0; i < 20; i++) age(join(runs, `newest-${pad(i)}`), OLD);

  assert.equal(pruneRuns(opts), 200, 'the per-run budget caps the backlog');
  for (let i = 0; i < 20; i++) {
    assert.ok(existsSync(join(runs, `newest-${pad(i)}`)), `newest-${pad(i)} survives the keep window`);
  }
  const left = readdirSync(runs).filter((name) => name.startsWith('bulk-'));
  assert.equal(left.length, 80, '300 candidates minus the 20 kept minus the 200 removed');
});

test('A3: a prune that cannot read the root is silent, never fatal', (t) => {
  const root = fixture(t);
  const opts = { _tmpdir: () => root, env: { UI_PROBE_TEMP: join(root, 'absent') } };
  assert.equal(pruneRuns(opts), 0);
});

// A4 ---------------------------------------------------------------------------

test('A4: a caller-supplied outDir is never pruned', (t) => {
  const root = fixture(t);
  const env = { UI_PROBE_TEMP: join(root, 'ui-probe') };
  const opts = { _tmpdir: () => root, env };
  // Past the keep window, so a prune of any kind would reach at least the oldest one.
  for (let i = 0; i < 21; i++) {
    makeRun(join(runsDir(opts), `old-${pad(i)}`));
    age(join(runsDir(opts), `old-${pad(i)}`), 48 * HOUR + i);
  }
  const old = join(runsDir(opts), 'old-20');

  const calls = [];
  const fs = {
    readdirSync,
    statSync,
    rmSync: (path, options) => {
      calls.push(path);
      rmSync(path, options);
    },
  };
  assert.equal(resolveOutDir({ outDir: join(root, 'mine') }, undefined, { ...opts, _fs: fs }), join(root, 'mine'));
  assert.equal(resolveOutDir({ outDir: join(root, 'mine') }, join(root, 'flag'), { ...opts, _fs: fs }), join(root, 'flag'));
  assert.deepEqual(calls, [], 'neither branch reaches rmSync');
  assert.ok(existsSync(old), 'the stale run is still there for a default run to prune');
});

// A8 ---------------------------------------------------------------------------

test('A8: a defaulted config reaches the prune on its way to the run dir', (t) => {
  const root = fixture(t);
  const temp = join(root, 'ui-probe');
  const previous = process.env.UI_PROBE_TEMP;
  process.env.UI_PROBE_TEMP = temp;
  t.after(() => {
    if (previous === undefined) delete process.env.UI_PROBE_TEMP;
    else process.env.UI_PROBE_TEMP = previous;
  });
  const configDir = join(root, 'config');
  mkdirSync(configDir);
  const file = join(configDir, '.ui-probe.json');
  writeFileSync(file, JSON.stringify({ baseUrl: 'http://127.0.0.1:9' }));
  const config = loadConfig(file);

  const runs = join(temp, 'runs');
  // The 20 fresh dirs fill the keep window, so the stale one is the only prune candidate.
  for (let i = 0; i < 20; i++) {
    makeRun(join(runs, `fresh-${pad(i)}`));
    age(join(runs, `fresh-${pad(i)}`), HOUR);
  }
  const stale = join(runs, 'stale');
  makeRun(stale);
  age(stale, 48 * HOUR);

  const calls = [];
  const fs = {
    readdirSync,
    statSync,
    rmSync: (path, options) => {
      calls.push(path);
      rmSync(path, options);
    },
  };
  const resolved = resolveOutDir(config, undefined, { _tmpdir: () => root, env: process.env, _fs: fs });
  assert.equal(resolved, config.outDir, 'the defaulted dir is what a run writes to');
  assert.deepEqual(calls, [stale], 'resolveOutDir reached the prune');
  assert.equal(existsSync(stale), false, 'the stale run is gone');
  for (let i = 0; i < 20; i++) {
    assert.ok(existsSync(join(runs, `fresh-${pad(i)}`)), `fresh-${pad(i)} is under 24 h`);
  }
});

// A5 ---------------------------------------------------------------------------

test('A5: only a direct child of either profile root with our prefix is ours', (t) => {
  const root = fixture(t);
  const profiles = join(root, 'ui-probe', 'profiles');
  assert.equal(isUiProbeProfile(join(profiles, `${PROFILE_PREFIX}x`), { tmpDir: root }), true);
  assert.equal(isUiProbeProfile(join(root, `${PROFILE_PREFIX}x`), { tmpDir: root }), true, 'the legacy location');
  assert.equal(isUiProbeProfile(join(profiles, 'other-x'), { tmpDir: root }), false);
  assert.equal(isUiProbeProfile(join(profiles, `${PROFILE_PREFIX}x`, 'y'), { tmpDir: root }), false);
  assert.equal(isUiProbeProfile(join(root, 'other-x'), { tmpDir: root }), false);
  assert.equal(isUiProbeProfile(join(tmpdir(), '..', `${PROFILE_PREFIX}x`), { tmpDir: root }), false);
});

test('A5: one stale legacy profile opens the pre-scan gate', async (t) => {
  const root = fixture(t);
  const tmpDir = join(root, 'tmp');
  const profilesRoot = join(tmpDir, 'ui-probe', 'profiles');
  mkdirSync(profilesRoot, { recursive: true });
  const legacy = join(tmpDir, `${PROFILE_PREFIX}legacy`);
  mkdirSync(legacy);
  writeOwnerFile(legacy, { pid: 9001, startMs: 1_000 });
  age(legacy, 2 * HOUR);

  const result = await preScanProfiles({
    tmpDir,
    profilesRoot,
    isAlive: () => true,
    queryStarts: async () => new Map(),
  });
  assert.equal(result.skip, false, 'a clean new root never licenses skipping');
  assert.equal(result.reason, 'stale');
});
