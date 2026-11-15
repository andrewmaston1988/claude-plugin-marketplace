import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { shouldPickUp, buildPickupNote, classifyState } from '../session-start-compact.mjs';
import { SKELETON_MARKER, readStateHead, latestPrecompactSnapshot, docsDirPath } from '../lib/paths.mjs';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.resolve(HOOKS, '..', 'skills', 'checkpoint', 'templates', 'state-template.md');

test('shouldPickUp: only the compact source fires', () => {
  const base = { source: 'compact', enabled: true, correlation: false };
  assert.equal(shouldPickUp(base), true);
  assert.equal(shouldPickUp({ ...base, source: 'startup' }), false);
  assert.equal(shouldPickUp({ ...base, source: 'clear' }), false);
  assert.equal(shouldPickUp({ ...base, source: 'resume' }), false);
  assert.equal(shouldPickUp({ ...base, enabled: false }), false);
  assert.equal(shouldPickUp({ ...base, correlation: true }), false);
});

test('every non-rich note names the qualified skill id and disambiguates it', () => {
  for (const kind of ['skeleton', 'none', 'unresolved']) {
    const note = buildPickupNote(kind, 'C:/x/STATE_a_1.md');
    // Bare "checkpoint" collides with the CLI's built-in checkpoint/rewind.
    assert.match(note, /skill="checkpoint:checkpoint"/);
    assert.match(note, /not the built-in checkpoint\/rewind/i);
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
test('the non-rich notes state what actually happened and name the path', () => {
  const p = 'C:/proj/STATE_slug_abc_20260822T140000Z.md';

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

// ---- row 7: rich note with a STATE written from the template ----

function stateFromTemplate(overrides = {}) {
  let body = fs.readFileSync(TEMPLATE, 'utf8');
  // Drop the instruction preamble; keep the fenced STATE body.
  const fence = body.match(/```\n([\s\S]*?)\n```/);
  assert.ok(fence, 'template carries a fenced STATE body');
  body = fence[1];
  const values = {
    '<one-line continuation description>': 'row 7 test session',
    '<date/time>': '2026-11-15 12:00',
    '<absolute path>   branch: <name> (clean|dirty)': '/tmp/proj   branch: main (clean)',
    '<the single first action the next session should take>': 'run the failing test',
    '<sibling docs dir path for substantial write-ups; omit if unused>': 'docs/',
    ...overrides,
  };
  for (const [k, v] of Object.entries(values)) body = body.split(k).join(v);
  return body;
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-note-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function writeState(dir, body, sid = 'sid7', stamp = '20261115T120000Z') {
  const p = path.join(dir, `STATE_${sid}_${stamp}.md`);
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

test('row 7a: rich note leads with the read-first sentence, then the snapshot, then the head verbatim', () => {
  withTempDir((dir) => {
    const body = stateFromTemplate();
    const statePath = writeState(dir, body);
    const docsDir = docsDirPath(statePath);
    fs.mkdirSync(docsDir, { recursive: true });
    const snap = path.join(docsDir, 'precompact-20261115T130000Z.md');
    fs.writeFileSync(snap, 'snapshot body', 'utf8');

    const note = buildPickupNote('rich', statePath);
    assert.ok(note.startsWith(`Read \`${statePath}\` in full before your next action`),
      `note must lead with the read-first sentence, got: ${note.slice(0, 120)}`);
    assert.ok(note.indexOf('precompact-20261115T130000Z.md') > note.indexOf('before your next action'),
      'snapshot path comes after the read-first sentence');
    // Header block verbatim (frontmatter, fences and all) and NEXT ACTIONS verbatim.
    const head = body.split('## OBJECTIVE')[0];
    assert.ok(note.includes(head.trimEnd()), 'header block appears verbatim');
    assert.ok(note.includes('## NEXT ACTIONS'), 'NEXT ACTIONS section appears');
    const nextActions = body.split('## NEXT ACTIONS')[1].split('\n## ')[0];
    assert.ok(note.includes(`## NEXT ACTIONS${nextActions}`.trimEnd()), 'NEXT ACTIONS verbatim');
  });
});

test('row 7a: readStateHead returns the header block and NEXT ACTIONS verbatim', () => {
  withTempDir((dir) => {
    const body = stateFromTemplate();
    const statePath = writeState(dir, body);
    const head = readStateHead(statePath, 10_000);
    assert.ok(head.startsWith('---'), 'head starts with the frontmatter fence');
    assert.ok(head.includes('session: row 7 test session'));
    assert.ok(head.includes('resume:  run the failing test'));
    assert.ok(head.includes('## NEXT ACTIONS'));
    assert.ok(!head.includes('## OBJECTIVE'), 'head stops before later sections');
  });
});

test('row 7b: a head over budget is truncated with a pointer', () => {
  withTempDir((dir) => {
    const body = stateFromTemplate().replace(
      '1. … (ordered; #1 == the `resume:` header line)',
      '1. ' + 'x'.repeat(5_000));
    const statePath = writeState(dir, body);
    const head = readStateHead(statePath, 500);
    assert.ok(head.length <= 500, `head must fit the budget, got ${head.length}`);
    assert.match(head, /…read the file for the rest$/);
  });
});

test('row 7c: a STATE with no NEXT ACTIONS yields the header alone', () => {
  withTempDir((dir) => {
    const body = stateFromTemplate().replace(/## NEXT ACTIONS[\s\S]*?(?=\n## )/, '');
    assert.ok(!body.includes('## NEXT ACTIONS'));
    const statePath = writeState(dir, body);
    const head = readStateHead(statePath, 10_000);
    assert.ok(head.includes('session: row 7 test session'), 'header survives');
    assert.ok(!head.includes('## NEXT ACTIONS'), 'no phantom NEXT ACTIONS');
    const note = buildPickupNote('rich', statePath);
    assert.ok(note.includes('session: row 7 test session'));
  });
});

test('row 7d: the note stays within 10,000 chars even with a huge NEXT ACTIONS', () => {
  withTempDir((dir) => {
    const body = stateFromTemplate().replace(
      '1. … (ordered; #1 == the `resume:` header line)',
      '1. ' + 'y'.repeat(50_000));
    const statePath = writeState(dir, body);
    const note = buildPickupNote('rich', statePath);
    assert.ok(note.length <= 10_000, `note must stay within 10,000 chars, got ${note.length}`);
    assert.ok(note.startsWith(`Read \`${statePath}\` in full before your next action`));
  });
});

test('latestPrecompactSnapshot picks the newest snapshot, or empty', () => {
  withTempDir((dir) => {
    assert.equal(latestPrecompactSnapshot(path.join(dir, 'missing')), '');
    const docs = path.join(dir, 'docs');
    fs.mkdirSync(docs);
    assert.equal(latestPrecompactSnapshot(docs), '');
    fs.writeFileSync(path.join(docs, 'precompact-20261115T010000Z.md'), 'a');
    fs.writeFileSync(path.join(docs, 'precompact-20261115T030000Z.md'), 'b');
    fs.writeFileSync(path.join(docs, 'precompact-20261115T020000Z.md'), 'c');
    fs.writeFileSync(path.join(docs, 'unrelated.md'), 'd');
    assert.equal(latestPrecompactSnapshot(docs), path.join(docs, 'precompact-20261115T030000Z.md'));
  });
});
