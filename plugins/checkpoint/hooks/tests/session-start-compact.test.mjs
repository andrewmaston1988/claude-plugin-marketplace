import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { shouldPickUp, buildPickupNote, classifyState } from '../session-start-compact.mjs';
import { SKELETON_MARKER } from '../lib/paths.mjs';

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

test('every note names the qualified skill id and disambiguates it', () => {
  for (const kind of ['skeleton', 'rich', 'none', 'unresolved']) {
    const note = buildPickupNote(kind, 'C:/x/STATE_a_1.md');
    // Bare "checkpoint" collides with the CLI's built-in checkpoint/rewind.
    assert.match(note, /skill="checkpoint:checkpoint"/);
    assert.match(note, /not the built-in checkpoint\/rewind/i);
    assert.match(note, /compact/i);
  }
});

test('classifyState reads the file rather than assuming a write happened', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-classify-'));
  const write = (name, body) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    return p;
  };
  // Several sessions can share a cwd; 'no sid' is not 'no STATE file'.
  assert.equal(classifyState(''), 'unresolved');
  assert.equal(classifyState(path.join(dir, 'absent.md')), 'none');
  assert.equal(classifyState(dir), 'unresolved'); // a directory reads as present-but-unreadable
  assert.equal(classifyState(write('empty.md', '   \n')), 'none');
  assert.equal(classifyState(write('skel.md', 'x\n_' + SKELETON_MARKER + '. y_\n')), 'skeleton');
  assert.equal(classifyState(write('rich.md', '# STATE\n## OBJECTIVE\nreal work\n')), 'rich');
  fs.rmSync(dir, { recursive: true, force: true });
});

// The note used to claim a skeleton was written on every compaction. PreCompact
// skips the write whenever a real checkpoint exists, so that was usually false.
test('the note states what actually happened and names the path', () => {
  const p = 'C:/proj/STATE_slug_abc_20260822T140000Z.md';

  const rich = buildPickupNote('rich', p);
  assert.ok(rich.includes(p), 'rich note must name the STATE path');
  assert.doesNotMatch(rich, /wrote a skeletal|was written by/i,
    'rich note must not claim PreCompact wrote anything');
  assert.match(rich, /left it alone/i);

  const skel = buildPickupNote('skeleton', p);
  assert.ok(skel.includes(p), 'skeleton note must name the STATE path');
  assert.match(skel, /wrote a skeletal STATE/i);

  const none = buildPickupNote('none', '');
  assert.match(none, /No STATE file exists/i);
  assert.match(none, /to write one/i);
  assert.doesNotMatch(none, /skeletal/i);

  // Claiming "no STATE file" in a cwd that may hold several is the same lie.
  const unresolved = buildPickupNote('unresolved', '');
  assert.doesNotMatch(unresolved, /No STATE file exists/i);
  assert.match(unresolved, /could not be resolved/i);
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
