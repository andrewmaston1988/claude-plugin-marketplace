import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldPickUp, buildPickupNote } from '../session-start-compact.mjs';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('shouldPickUp: only the compact source fires', () => {
  const base = { source: 'compact', enabled: true, correlation: false };
  assert.equal(shouldPickUp(base), true);
  assert.equal(shouldPickUp({ ...base, source: 'startup' }), false);
  assert.equal(shouldPickUp({ ...base, source: 'clear' }), false);
  assert.equal(shouldPickUp({ ...base, source: 'resume' }), false);
  assert.equal(shouldPickUp({ ...base, enabled: false }), false);
  assert.equal(shouldPickUp({ ...base, correlation: true }), false);
});

test('buildPickupNote names the qualified skill id and disambiguates it', () => {
  const note = buildPickupNote();
  // Bare "checkpoint" collides with the CLI's built-in checkpoint/rewind.
  assert.match(note, /skill="checkpoint:checkpoint"/);
  assert.match(note, /not the built-in checkpoint\/rewind/i);
  assert.match(note, /compact/i);
});

// A shared on-disk flag cannot say which session compacted; the harness event
// can. Guards against the sentinel being reintroduced.
test('no compaction sentinel file survives anywhere in the plugin', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!/\.(mjs|json)$/.test(entry.name)) continue;
      if (entry.name === path.basename(fileURLToPath(import.meta.url))) continue;
      const body = fs.readFileSync(p, 'utf8');
      // Quoted path or the old const — a prose mention of the retired sentinel
      // in a comment is history, not a reintroduction.
      if (/\.compact_just_ran'|\bMARKER\b/.test(body)) offenders.push(p);
    }
  };
  walk(HOOKS);
  assert.deepEqual(offenders, [], `sentinel references still present: ${offenders.join(', ')}`);
});

test('hooks.json routes compact to this hook and keeps it off fresh starts', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
  const entries = cfg.hooks.SessionStart;
  const find = (needle) => entries.find(e =>
    e.hooks.some(h => h.command.includes(needle)));

  const compact = find('session-start-compact.mjs');
  assert.ok(compact, 'session-start-compact.mjs must be wired to SessionStart');
  // Without an explicit matcher the harness does not deliver source='compact'.
  assert.match(compact.matcher || '', /compact/);

  const resume = find('session-start-resume.mjs');
  assert.ok(resume, 'session-start-resume.mjs must stay wired');
  assert.doesNotMatch(resume.matcher || '', /compact/,
    'the resume offer must not fire after a compaction');
});
