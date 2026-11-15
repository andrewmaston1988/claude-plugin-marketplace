import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  compactTrigger, readSettingsChain, modelSettingsEntry, COMPACT_BUFFER_TOKENS,
} from '../lib/compact-trigger.mjs';
import { decideCheckpointNudge } from '../lib/context.mjs';
import { CLAUDE_CATALOG } from './helpers/catalog.mjs';

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-4-5-20251001';
const DEEPSEEK = 'deepseek-v4.1-flash:1017-cloud';

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

test('readSettingsChain: local, project, user; missing or unparsable is {}', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-trigger-'));
  try {
    const cwd = path.join(root, 'repo');
    const home = path.join(root, 'home');
    write(path.join(cwd, '.claude', 'settings.local.json'), '{"a":1}');
    write(path.join(cwd, '.claude', 'settings.json'), 'not json');
    write(path.join(home, '.claude', 'settings.json'), '{"b":2}');
    assert.deepEqual(readSettingsChain(cwd, home), [{ a: 1 }, {}, { b: 2 }]);
    assert.deepEqual(readSettingsChain(path.join(root, 'nowhere'), path.join(root, 'nohome')), [{}, {}, {}]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('modelSettingsEntry: exact, [1m]/date stripped, then longest contained key', () => {
  // The shorter key comes first so a first-match implementation is visibly wrong.
  const ms = {
    'claude-opus-5': { autoCompactWindow: 400_000 },
    'claude-opus-5-5': { autoCompactWindow: 500_000 },
  };
  assert.equal(modelSettingsEntry(ms, 'claude-opus-5-5').autoCompactWindow, 500_000);
  assert.equal(modelSettingsEntry(ms, 'claude-opus-5-5[1m]').autoCompactWindow, 500_000);
  assert.equal(modelSettingsEntry(ms, 'claude-opus-5-5-20251101').autoCompactWindow, 500_000);
  assert.equal(modelSettingsEntry(ms, 'us.anthropic.claude-opus-5-5-v1:0').autoCompactWindow, 500_000);
  assert.equal(modelSettingsEntry(ms, 'glm-5.2:cloud'), undefined);
  assert.equal(modelSettingsEntry(null, OPUS), undefined);
});

test('compactTrigger: env beats modelSettings beats top-level', () => {
  const settings = {
    autoCompactWindow: 400_000,
    modelSettings: { [OPUS]: { autoCompactWindow: 500_000 } },
  };
  assert.deepEqual(
    compactTrigger({
      model: OPUS, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000' },
      settingsChain: [settings], catalog: CLAUDE_CATALOG,
    }),
    { tokens: 567_000, window: 600_000, source: 'env' },
  );
  assert.deepEqual(
    compactTrigger({ model: OPUS, env: {}, settingsChain: [settings], catalog: CLAUDE_CATALOG }),
    { tokens: 467_000, window: 500_000, source: 'modelSettings' },
  );
  assert.deepEqual(
    compactTrigger({
      model: OPUS, env: {}, settingsChain: [{ autoCompactWindow: 400_000 }], catalog: CLAUDE_CATALOG,
    }),
    { tokens: 367_000, window: 400_000, source: 'settings' },
  );
});

test('compactTrigger: within each key local > project > user, and a key outranks a file', () => {
  const forModel = (v) => ({ modelSettings: { [OPUS]: { autoCompactWindow: v } } });
  assert.equal(compactTrigger({
    model: OPUS, env: {}, catalog: CLAUDE_CATALOG,
    settingsChain: [forModel(500_000), forModel(600_000), { autoCompactWindow: 700_000 }],
  }).window, 500_000);
  assert.equal(compactTrigger({
    model: OPUS, env: {}, catalog: CLAUDE_CATALOG,
    settingsChain: [{}, { autoCompactWindow: 450_000 }, { autoCompactWindow: 700_000 }],
  }).window, 450_000);
  // A project modelSettings entry still beats a local top-level one.
  assert.equal(compactTrigger({
    model: OPUS, env: {}, catalog: CLAUDE_CATALOG,
    settingsChain: [{ autoCompactWindow: 400_000 }, forModel(600_000)],
  }).window, 600_000);
});

test('compactTrigger: a window outside 100k-1M falls through to the next source', () => {
  assert.deepEqual(compactTrigger({
    model: SONNET, env: {}, catalog: CLAUDE_CATALOG,
    settingsChain: [{ modelSettings: { [SONNET]: { autoCompactWindow: 50_000 } }, autoCompactWindow: 400_000 }],
  }), { tokens: 367_000, window: 400_000, source: 'settings' });
  assert.equal(compactTrigger({
    model: OPUS, env: {}, catalog: CLAUDE_CATALOG, settingsChain: [{ autoCompactWindow: 2_000_000 }],
  }).source, 'model');
  assert.equal(compactTrigger({
    model: OPUS, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'nope' }, catalog: CLAUDE_CATALOG,
    settingsChain: [{ autoCompactWindow: 400_000 }],
  }).window, 400_000);
});

test('compactTrigger: the catalog window caps a configured one only for a listed model', () => {
  const settingsChain = [{ autoCompactWindow: 400_000 }];
  // Sonnet 5.5 is listed at 1M, so the 400k setting survives under it.
  assert.deepEqual(compactTrigger({ model: SONNET, env: {}, settingsChain, catalog: CLAUDE_CATALOG }),
    { tokens: 367_000, window: 400_000, source: 'settings' });
  // Haiku 4.5 is listed at 200k, so the 400k setting is capped.
  assert.deepEqual(compactTrigger({ model: HAIKU, env: {}, settingsChain, catalog: CLAUDE_CATALOG }),
    { tokens: 167_000, window: 200_000, source: 'settings' });
  // A `[1m]` id opts into a 1M window whatever the catalog says.
  assert.deepEqual(compactTrigger({
    model: 'claude-haiku-4-5[1m]', env: {}, settingsChain, catalog: CLAUDE_CATALOG,
  }), { tokens: 367_000, window: 400_000, source: 'settings' });
});

test('compactTrigger: the model window when nothing is set; the 33k buffer', () => {
  assert.equal(COMPACT_BUFFER_TOKENS, 33_000);
  assert.deepEqual(
    compactTrigger({ model: SONNET, env: {}, settingsChain: [], catalog: CLAUDE_CATALOG }),
    { tokens: 967_000, window: 1_000_000, source: 'model' },
  );
  assert.equal(compactTrigger({
    model: OPUS, env: {}, catalog: CLAUDE_CATALOG,
    settingsChain: [{ modelSettings: { [OPUS]: { autoCompactWindow: 500_000 } } }],
  }).tokens, 467_000);
});

test('compactTrigger: PCT_OVERRIDE only ever lowers the token count', () => {
  const base = { model: OPUS, settingsChain: [], catalog: CLAUDE_CATALOG };
  assert.equal(compactTrigger({ ...base, env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' } }).tokens, 483_500);
  assert.equal(compactTrigger({ ...base, env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '150' } }).tokens, 967_000);
  assert.equal(compactTrigger({ ...base, env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '0' } }).tokens, 967_000);
});

test('compactTrigger: an unlisted model gets 200k, and a configured window is not capped', () => {
  assert.deepEqual(
    compactTrigger({ model: DEEPSEEK, env: {}, settingsChain: [], catalog: CLAUDE_CATALOG }),
    { tokens: 167_000, window: 200_000, source: 'model' },
  );
  assert.deepEqual(compactTrigger({
    model: DEEPSEEK, env: {}, catalog: CLAUDE_CATALOG, settingsChain: [{ autoCompactWindow: 400_000 }],
  }), { tokens: 367_000, window: 400_000, source: 'settings' });
});

// The operator's own settings, and the band lines they put the nudge on.
const OPERATOR = [{
  autoCompactWindow: 400_000,
  modelSettings: {
    [OPUS]: { autoCompactWindow: 500_000 },
    [DEEPSEEK]: { autoCompactWindow: 400_000 },
  },
}];
const RESERVE = 60_000;
const triggerFor = (model) =>
  compactTrigger({ model, env: {}, settingsChain: OPERATOR, catalog: CLAUDE_CATALOG }).tokens;

test('operator settings: Opus compacts at 467k, bands at 347k and 407k', () => {
  const trigger = triggerFor(OPUS);
  assert.equal(trigger, 467_000);
  assert.equal(decideCheckpointNudge({ used: 346_999, trigger, reserve: RESERVE }).band, null);
  assert.equal(decideCheckpointNudge({ used: 347_000, trigger, reserve: RESERVE }).band, 'soon');
  assert.equal(decideCheckpointNudge({ used: 407_000, trigger, reserve: RESERVE }).band, 'now');
});

test('operator settings: deepseek compacts at 367k, bands at 247k and 307k', () => {
  const trigger = triggerFor(DEEPSEEK);
  assert.equal(trigger, 367_000);
  assert.equal(decideCheckpointNudge({ used: 246_999, trigger, reserve: RESERVE }).band, null);
  assert.equal(decideCheckpointNudge({ used: 247_000, trigger, reserve: RESERVE }).band, 'soon');
  assert.equal(decideCheckpointNudge({ used: 307_000, trigger, reserve: RESERVE }).band, 'now');
});

test('operator settings: Sonnet 5.5 compacts at 367k, bands at 247k and 307k', () => {
  const trigger = triggerFor(SONNET);
  assert.equal(trigger, 367_000);
  assert.equal(decideCheckpointNudge({ used: 246_999, trigger, reserve: RESERVE }).band, null);
  assert.equal(decideCheckpointNudge({ used: 247_000, trigger, reserve: RESERVE }).band, 'soon');
  assert.equal(decideCheckpointNudge({ used: 307_000, trigger, reserve: RESERVE }).band, 'now');
});

test('operator settings: Haiku 4.5 compacts at 167k, reserve clamped to 41,750', () => {
  const trigger = triggerFor(HAIKU);
  assert.equal(trigger, 167_000);
  assert.equal(decideCheckpointNudge({ used: 83_499, trigger, reserve: RESERVE }).band, null);
  assert.equal(decideCheckpointNudge({ used: 83_500, trigger, reserve: RESERVE }).band, 'soon');
  assert.equal(decideCheckpointNudge({ used: 125_250, trigger, reserve: RESERVE }).band, 'now');
});
