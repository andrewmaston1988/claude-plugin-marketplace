import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  lintState, liveSectionsHash,
  RESUME_MAX, SESSION_MAX, FILE_MAX, SECTION_MAX,
  SAVED_RE, SAVED_EXAMPLE, SECTIONS, LIVE_SECTIONS,
} from '../lib/state-lint.mjs';

const DOCS = path.join(os.tmpdir(), 'STATE_my-task_sid-a_20261118T010000Z-docs');

function validState({
  session = 'resume checkpoint work',
  saved = '2026-11-18 01:56 UTC',
  resume = 'Port the adopt branch',
  next = '1. Port the adopt branch, then grade the leaves.',
  keyFiles = '- plugins/checkpoint/hooks/lib/paths.mjs:1 — stamping.',
  currentState = 'In progress.',
} = {}) {
  return [
    '---',
    `session: ${session}`,
    `saved: ${saved}`,
    'cwd: C:/code/x   branch: main (clean)',
    `resume: ${resume}`,
    '---',
    '',
    '## OBJECTIVE              [stable]',
    'Make checkpoints reconcile.',
    '',
    '## CURRENT STATE          [live]',
    currentState,
    '',
    '## NEXT ACTIONS           [live]',
    next,
    '',
    '## CONSTRAINTS & DECISIONS [stable]',
    'ESM only.',
    '',
    '## ENV & COMMANDS         [stable]',
    'node scripts/test.mjs',
    '',
    '## KEY FILES              [live]',
    keyFiles,
    '',
    '## OUT OF SCOPE           [stable]',
    'Migrations.',
    '',
  ].join('\n');
}

const fieldsNamed = (errors, rule) => errors.filter(e => e.startsWith(rule + ':'));

test('bound constants and the saved form stay at the corpus values', () => {
  assert.equal(RESUME_MAX, 400);
  assert.equal(SESSION_MAX, 300);
  assert.equal(FILE_MAX, 40_000);
  assert.equal(SECTION_MAX, 8_000);
  assert.equal(SAVED_EXAMPLE.length, 20);
  assert.ok(SAVED_RE.test(SAVED_EXAMPLE));
  assert.equal(SECTIONS.length, 7);
  assert.deepEqual(LIVE_SECTIONS, ['CURRENT STATE', 'NEXT ACTIONS', 'KEY FILES']);
});

test('C6: the template states the lint\'s own bounds', () => {
  const template = fs.readFileSync(
    new URL('../../skills/checkpoint/templates/state-template.md', import.meta.url), 'utf8');
  const stated = (re, what) => {
    const m = template.match(re);
    assert.ok(m, `template must state the ${what} bound in the lint's words`);
    return Number(m[1].replace(/,/g, ''));
  };
  assert.equal(stated(/`resume:` ≤ ([\d,]+)/, 'resume'), RESUME_MAX);
  assert.equal(stated(/`session:` ≤ ([\d,]+)/, 'session'), SESSION_MAX);
  assert.equal(stated(/whole file stays ≤ ([\d,]+)/, 'file'), FILE_MAX);
  assert.equal(stated(/any one section ≤ ([\d,]+)/, 'section'), SECTION_MAX);

  // The template's stated saved: form is the lint's pattern, example included.
  const form = template.match(/`saved:` is written for you by the `stampState` helper as `([^`]+)`/);
  assert.ok(form, 'template must state the saved: form');
  const derived = form[1]
    .replace('YYYY', '\\d{4}').replace('MM', '\\d{2}').replace('DD', '\\d{2}')
    .replace('HH', '\\d{2}').replace('MM', '\\d{2}');
  assert.equal(`^${derived}$`, SAVED_RE.source, 'template saved: form must equal the lint pattern');
  assert.ok(new RegExp(`^${derived}$`).test(SAVED_EXAMPLE),
    `the lint's example "${SAVED_EXAMPLE}" must fit the template's form "${form[1]}"`);
});

test('C1: header fields are single-line and within their caps', () => {
  // A continuation line is the header-as-log symptom.
  const multiline = validState().replace(
    'session: resume checkpoint work',
    'session: resume checkpoint work\n  [~01:56 LATEST] a note',
  );
  const logErrors = fieldsNamed(lintState(multiline).errors, 'session');
  assert.ok(logErrors.some(e => /log/.test(e)), `multi-line session must fail, got: ${logErrors}`);

  // session: 300 passes, 301 fails.
  assert.deepEqual(lintState(validState({ session: 's'.repeat(300) })).errors, []);
  const sessionErrors = fieldsNamed(lintState(validState({ session: 's'.repeat(301) })).errors, 'session');
  assert.ok(sessionErrors.some(e => /301 characters/.test(e)), `session cap must fire, got: ${sessionErrors}`);

  // resume: 400 passes, 401 fails (NEXT ACTIONS #1 mirrors it, so only the cap decides).
  const r400 = 'r'.repeat(400);
  assert.deepEqual(lintState(validState({ resume: r400, next: `1. ${r400} then finish.` })).errors, []);
  const r401 = 'r'.repeat(401);
  const resumeErrors = fieldsNamed(lintState(validState({ resume: r401, next: `1. ${r401} then finish.` })).errors, 'resume');
  assert.ok(resumeErrors.some(e => /401 characters/.test(e)), `resume cap must fire, got: ${resumeErrors}`);
});

test('C1: saved: must be the clock form', () => {
  for (const bad of [
    'around 2am',
    '2026-11-18 ~23:15 UTC — LATEST: still going',
    '2026-11-18 01:56 UTC — LATEST: more notes', // 41 characters
  ]) {
    const errors = fieldsNamed(lintState(validState({ saved: bad })).errors, 'saved');
    assert.ok(errors.length > 0, `saved "${bad}" must fail`);
  }
  assert.equal('2026-11-18 01:56 UTC — LATEST: more notes'.length, 41);
  assert.deepEqual(lintState(validState({ saved: '2026-11-18 01:56 UTC' })).errors, []);
});

test('C2: resume must be the start of NEXT ACTIONS #1', () => {
  const stale = lintState(validState({
    resume: 'Port the adopt branch',
    next: '1. Grade the leaves against the plan.',
  })).errors;
  assert.ok(fieldsNamed(stale, 'resume').some(e => /NEXT ACTIONS #1/.test(e)),
    `a resume line over a stale list must fail, got: ${stale}`);

  assert.deepEqual(lintState(validState({
    resume: 'Port the adopt branch',
    next: '1. Port the adopt branch, then grade the leaves.',
  })).errors, []);

  // Whitespace is normalised on both sides before the prefix check.
  assert.deepEqual(lintState(validState({
    resume: 'Port  the   adopt branch',
    next: '1.   Port the adopt   branch,   then grade the leaves.',
  })).errors, []);
});

test('C3: file and section budgets name the docs dir', () => {
  const base = validState();
  const big = base + 'x'.repeat(FILE_MAX + 1 - base.length);
  assert.equal(big.length, 40_001);
  const fileErrors = fieldsNamed(lintState(big, { docsDir: DOCS }).errors, 'file');
  assert.ok(fileErrors.some(e => e.includes(DOCS)), `file budget must name the docs dir, got: ${fileErrors}`);

  const section = validState({ currentState: 'y'.repeat(8_001) });
  const sectionErrors = fieldsNamed(lintState(section, { docsDir: DOCS }).errors, 'section "CURRENT STATE"');
  assert.ok(sectionErrors.some(e => e.includes(DOCS)), `section budget must name the docs dir, got: ${sectionErrors}`);

  assert.deepEqual(lintState(validState(), { docsDir: DOCS }).errors, []);
});

test('C4: docs-dir files are linked, and named docs paths exist', () => {
  const unlinked = lintState(validState(), { docsDir: DOCS, docsFiles: ['design.md'] }).errors;
  assert.ok(fieldsNamed(unlinked, 'docs').some(e => e.includes('design.md')),
    `an unlinked docs file must fail, got: ${unlinked}`);

  const named = validState({ keyFiles: `- ${DOCS}/gone.md — missing.` });
  const missing = lintState(named, { docsDir: DOCS, docsFiles: [] }).errors;
  assert.ok(fieldsNamed(missing, 'docs').some(e => e.includes('gone.md')),
    `a named docs path that does not exist must fail, got: ${missing}`);

  // Pre-compact snapshots are the hooks' own writes, not the session's.
  assert.deepEqual(lintState(validState(), {
    docsDir: DOCS, docsFiles: ['precompact-20261118T010000Z.md'],
  }).errors, []);

  const linked = validState({ keyFiles: `- ${DOCS}/design.md — the design.` });
  assert.deepEqual(lintState(linked, { docsDir: DOCS, docsFiles: ['design.md'] }).errors, []);
});

test('C5: headings match by name, ignoring padding, tags and line endings', () => {
  assert.deepEqual(lintState(validState()).errors, []);

  const bare = validState().replace('## CURRENT STATE          [live]', '## CURRENT STATE');
  assert.deepEqual(lintState(bare).errors, []);

  const mixed = validState().replace('## KEY FILES              [live]', '## KEY FILES              [stable]');
  assert.deepEqual(lintState(mixed).errors, []);

  const crlf = validState().replace(/\n/g, '\r\n');
  assert.deepEqual(lintState(crlf).errors, []);
});

test('C7: a ui-probe-shaped file fails on C1, C2 and C3; a clean fixture passes', () => {
  const notes = Array.from({ length: 54 },
    (_, i) => `[~${String(i % 24).padStart(2, '0')}:15 LATEST] appended state note ${i}`).join(' ');
  const uiProbe = validState({
    session: `ui-probe build — ${notes}`,
    saved: `2026-11-17 21:29 UTC — LATEST: ${notes.slice(0, 120)}`,
    resume: notes,
    next: '1. Grade the leaves against the plan.',
  }) + '\n' + 'stale narrative line\n'.repeat(2_200);

  const { errors } = lintState(uiProbe, { docsDir: DOCS, docsFiles: [] });
  assert.ok(fieldsNamed(errors, 'session').some(e => /characters/.test(e)), 'C1: session cap');
  assert.ok(fieldsNamed(errors, 'saved').length > 0, 'C1: saved form');
  assert.ok(fieldsNamed(errors, 'resume').some(e => /characters/.test(e)), 'C1: resume cap');
  assert.ok(fieldsNamed(errors, 'resume').some(e => /NEXT ACTIONS #1/.test(e)), 'C2: resume disagrees');
  assert.ok(fieldsNamed(errors, 'file').length > 0, 'C3: file budget');

  assert.deepEqual(lintState(validState(), { docsDir: DOCS, docsFiles: [] }).errors, []);
});

test('liveSectionsHash ignores the header and moves with a live section', () => {
  const a = validState();
  const headerOnly = validState({ saved: '2026-11-19 02:00 UTC', resume: 'Port the adopt branch' });
  assert.equal(liveSectionsHash(a), liveSectionsHash(headerOnly));

  const moved = validState({ currentState: 'Shipped.' });
  assert.notEqual(liveSectionsHash(a), liveSectionsHash(moved));

  // Presentation changes to a live heading are not content.
  const repadded = validState().replace('## NEXT ACTIONS           [live]', '## NEXT ACTIONS [live]');
  assert.equal(liveSectionsHash(a), liveSectionsHash(repadded));
});
