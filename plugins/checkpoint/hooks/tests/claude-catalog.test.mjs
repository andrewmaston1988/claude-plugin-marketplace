import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { catalogModels, maxInputTokens, selectClaudeCatalog } from '../lib/claude-catalog.mjs';
import { contextWindowFor } from '../lib/context.mjs';
import { CATALOG_DIR, CLAUDE_CATALOG, catalogHome, writeCatalog } from './helpers/catalog.mjs';

const dirOf = (home) => path.join(home, CATALOG_DIR);

// ---- (a) the newest embedded fetchedAt wins, never the newest mtime ----

test('the newest embedded fetchedAt wins over the newest mtime', (t) => {
  const home = catalogHome(t);
  const older = writeCatalog(home, {
    name: 'older-cc.json', fetchedAt: 100,
    rows: [{ id: 'claude-opus-5-5', name: 'Opus 5.5', runtime: { max_input_tokens: 1_000_000 } }],
  });
  const newer = writeCatalog(home, {
    name: 'newer-cc.json', fetchedAt: 200,
    rows: [{ id: 'claude-opus-5-5', name: 'Opus 5.5', runtime: { max_input_tokens: 500_000 } }],
  });
  // The older content is the most recently written file on disk.
  const stamp = new Date(Date.now() + 60_000);
  fs.utimesSync(newer, new Date(1_000), new Date(1_000));
  fs.utimesSync(older, stamp, stamp);

  const selected = selectClaudeCatalog({ HOME: home });
  assert.equal(selected.file, 'newer-cc.json');
  assert.equal(selected.fetchedAt, 200);
  assert.equal(maxInputTokens(catalogModels({ HOME: home }), 'claude-opus-5-5'), 500_000);
});

test('USERPROFILE is read when HOME is absent', (t) => {
  const home = catalogHome(t);
  writeCatalog(home);
  assert.deepEqual(catalogModels({ USERPROFILE: home }), CLAUDE_CATALOG);
});

// ---- (b) no catalog, or a row with no window, gives no window ----

test('a missing, empty, corrupt or windowless catalog gives no window', (t) => {
  const home = catalogHome(t);
  assert.equal(selectClaudeCatalog({ HOME: home }), null);
  assert.deepEqual(catalogModels({ HOME: home }), []);

  fs.mkdirSync(dirOf(home), { recursive: true });
  assert.equal(selectClaudeCatalog({ HOME: home }), null, 'an empty directory has no catalog');

  fs.writeFileSync(path.join(dirOf(home), 'broken-cc.json'), '{', 'utf8');
  assert.equal(selectClaudeCatalog({ HOME: home }), null, 'a corrupt file does not throw');
  assert.deepEqual(catalogModels({ HOME: home }), []);

  writeCatalog(home, { rows: [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }] });
  const rows = catalogModels({ HOME: home });
  assert.equal(maxInputTokens(rows, 'claude-opus-5-5'), null);
  assert.equal(contextWindowFor('claude-opus-5-5', rows), 200_000, 'the caller falls back');
});

// ---- (c) wrapped, dated and [1m] ids resolve to their row ----

test('a [1m], date-suffixed or wrapped id resolves to its catalog row', () => {
  assert.equal(maxInputTokens(CLAUDE_CATALOG, 'claude-opus-5-5[1m]'), 1_000_000);
  assert.equal(maxInputTokens(CLAUDE_CATALOG, 'claude-opus-5-5-20261101'), 1_000_000);
  assert.equal(maxInputTokens(CLAUDE_CATALOG, 'us.anthropic.claude-opus-5-5-v1:0'), 1_000_000);
  assert.equal(maxInputTokens(CLAUDE_CATALOG, 'claude-haiku-4-5-20251001'), 200_000);
  assert.equal(maxInputTokens(CLAUDE_CATALOG, 'deepseek-v4.1-flash:1017-cloud'), null);
  assert.equal(maxInputTokens(undefined, 'claude-opus-5-5'), null);
  assert.equal(maxInputTokens(CLAUDE_CATALOG, undefined), null);
});

test('a wrapped id containing two catalog ids takes the longer one', () => {
  const rows = [
    { id: 'claude-opus-5', runtime: { max_input_tokens: 300_000 } },
    { id: 'claude-opus-5-5', runtime: { max_input_tokens: 1_000_000 } },
  ];
  assert.equal(maxInputTokens(rows, 'us.anthropic.claude-opus-5-5-v1:0'), 1_000_000);
});
