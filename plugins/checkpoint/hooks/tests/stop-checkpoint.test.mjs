import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanWorkSignals, decideStopNudge, buildStopNudge, stateStampMs, judgeCheckpoint, runStop,
  EDIT_NUDGE_THRESHOLD, NUDGE_COOLDOWN_MS,
} from '../stop-checkpoint.mjs';
import { projectDir } from '../lib/paths.mjs';
import { SECTIONS, lintState, liveSectionsHash } from '../lib/state-lint.mjs';
import { onPreToolUse, preImagePath, readPreImage } from '../lib/state-guard.mjs';

function line(obj) { return JSON.stringify(obj) + '\n'; }

function assistantToolUse(name, input = {}) {
  return line({
    message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
  });
}

test('scanWorkSignals: counts file-mutation tool uses', () => {
  const text = assistantToolUse('Edit', { file_path: 'a.js' })
    + assistantToolUse('Write', { file_path: 'b.js' })
    + assistantToolUse('NotebookEdit', { notebook_path: 'c.ipynb' })
    + assistantToolUse('Read', { file_path: 'd.js' });
  const { edits, commits } = scanWorkSignals(text);
  assert.equal(edits, 3);
  assert.equal(commits, 0);
});

test('scanWorkSignals: counts an answered AskUserQuestion as a ruling', () => {
  const text = assistantToolUse('AskUserQuestion', { questions: [{ question: 'Which?' }] });
  const { edits, commits, rulings } = scanWorkSignals(text);
  assert.deepEqual({ edits, commits, rulings }, { edits: 0, commits: 0, rulings: 1 });
});

test('scanWorkSignals: detects git commit via Bash and PowerShell', () => {
  const text = assistantToolUse('Bash', { command: 'git add x && git commit -m "done"' })
    + assistantToolUse('PowerShell', { command: 'git commit -m "msg"' })
    + assistantToolUse('Bash', { command: 'git status' });
  const { edits, commits } = scanWorkSignals(text);
  assert.equal(commits, 2);
  assert.equal(edits, 0);
});

test('scanWorkSignals: ignores user turns, garbage lines, and empty text', () => {
  const text = 'not json\n'
    + line({ message: { role: 'user', content: [{ type: 'tool_use', name: 'Edit', input: {} }] } })
    + '\n';
  assert.deepEqual(scanWorkSignals(text), { edits: 0, commits: 0, rulings: 0 });
  assert.deepEqual(scanWorkSignals(''), { edits: 0, commits: 0, rulings: 0 });
});

test('decideStopNudge: a commit alone trips it', () => {
  assert.equal(decideStopNudge({ edits: 0, commits: 1, lastNudgeTs: 0, now: 1_000_000 }), true);
});

test('decideStopNudge: edits below threshold do not trip it', () => {
  assert.equal(decideStopNudge({ edits: EDIT_NUDGE_THRESHOLD - 1, commits: 0, lastNudgeTs: 0, now: 1_000_000 }), false);
});

test('decideStopNudge: edits at threshold trip it', () => {
  assert.equal(decideStopNudge({ edits: EDIT_NUDGE_THRESHOLD, commits: 0, lastNudgeTs: 0, now: 1_000_000 }), true);
});

test('decideStopNudge: cooldown suppresses a second nudge', () => {
  const now = 10_000_000;
  assert.equal(decideStopNudge({ edits: 0, commits: 1, lastNudgeTs: now - NUDGE_COOLDOWN_MS + 1000, now }), false);
  assert.equal(decideStopNudge({ edits: 0, commits: 1, lastNudgeTs: now - NUDGE_COOLDOWN_MS - 1000, now }), true);
});

test('buildStopNudge: asks for judgment and a completion write-up, does not order a checkpoint unconditionally', () => {
  const note = buildStopNudge({ edits: 12, commits: 1 });
  assert.match(note, /skill="checkpoint:checkpoint"/);
  assert.match(note, /not the built-in checkpoint\/rewind/i);
  assert.match(note, /significant/i);
  assert.match(note, /completed/i);
  assert.match(note, /just stop|simply stop/i); // the not-significant branch must be explicit
  assert.doesNotMatch(note, /## 1\. OBJECTIVE/); // must NOT inline the template
});

test('stateStampMs: parses the embedded UTC stamp', () => {
  const ms = stateStampMs('STATE_my-slug_abc123_20260708T120000Z.md');
  assert.equal(ms, Date.UTC(2026, 6, 8, 12, 0, 0));
});

test('stateStampMs: returns 0 for non-STATE names', () => {
  assert.equal(stateStampMs('README.md'), 0);
  assert.equal(stateStampMs(''), 0);
});

// ---- Stop stand-down rules ----

function tmpDir(prefix = 'stop-cp-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// A STATE body that passes the lint: seven sections, one-line header, resume
// mirroring item 1.
function stateBody({
  resume = 'Do the next thing',
  current = 'Steady.',
  next = '1. Do the next thing',
  keyFiles = '- a.js — entry point',
  saved = '2026-11-18 01:56 UTC',
} = {}) {
  return [
    '---',
    'session: Fixture session for the stop hook',
    `resume: ${resume}`,
    `saved: ${saved}`,
    '---',
    '',
    '## OBJECTIVE [stable]',
    'Ship the fixture.',
    '',
    '## CURRENT STATE [live]',
    current,
    '',
    '## NEXT ACTIONS [live]',
    next,
    '',
    '## CONSTRAINTS & DECISIONS [stable]',
    'None.',
    '',
    '## ENV & COMMANDS [stable]',
    'node --test.',
    '',
    '## KEY FILES [live]',
    keyFiles,
    '',
    '## OUT OF SCOPE [stable]',
    'Nothing.',
    '',
  ].join('\n');
}

function ownStatePath(cwd, sid, stamp = '20261118T020000Z') {
  const dir = projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `STATE_${sid}_${stamp}.md`);
}

function writeTranscript(signals = '') {
  const p = path.join(tmpDir('stop-tx-'), 'transcript.jsonl');
  fs.writeFileSync(p, signals, 'utf8');
  return p;
}

function run(cwd, sid, { db, dir, signals = '' } = {}) {
  return runStop(
    { session_id: sid, cwd, transcript_path: writeTranscript(signals) },
    // Empty env: the ambient CORRELATION_ID would skip every headless session.
    { _db: db, _dir: dir, _settings: {}, _env: {}, _now: () => Date.UTC(2026, 10, 18, 2, 5, 0) },
  );
}

test('S1: a moved live hash stands down, stores lastLiveHash and clears the pre-image', () => {
  const cwd = tmpDir();
  const sid = 'sid-s1';
  const statePath = ownStatePath(cwd, sid);
  fs.writeFileSync(statePath, stateBody({ current: 'New state.' }), 'utf8');
  const dir = tmpDir();
  const dbPath = path.join(tmpDir(), 'state.json');
  fs.writeFileSync(preImagePath(sid, dir), JSON.stringify({
    hash: liveSectionsHash(stateBody({ current: 'Old state.' })),
    path: statePath,
    ts: Date.UTC(2026, 10, 18, 1, 0, 0),
  }), 'utf8');

  const out = run(cwd, sid, { db: dbPath, dir });

  assert.equal(out, null, 'no block');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  assert.equal(db[sid].lastLiveHash, liveSectionsHash(stateBody({ current: 'New state.' })));
  assert.equal(db[sid].lastStateStampMs, Date.UTC(2026, 10, 18, 2, 0, 0));
  assert.equal(readPreImage(sid, { _dir: dir }), null, 'pre-image cleared on stand-down');
});

test('S2: a header-only round blocks with the header-only reason', () => {
  const cwd = tmpDir();
  const sid = 'sid-s2';
  const statePath = ownStatePath(cwd, sid);
  const live = stateBody({ current: 'Same live state.' });
  fs.writeFileSync(statePath, live, 'utf8');
  const dir = tmpDir();
  const dbPath = path.join(tmpDir(), 'state.json');
  fs.writeFileSync(preImagePath(sid, dir), JSON.stringify({
    hash: liveSectionsHash(live), path: statePath, ts: Date.UTC(2026, 10, 18, 1, 0, 0),
  }), 'utf8');

  const out = run(cwd, sid, { db: dbPath, dir });

  assert.ok(out && out.reason);
  assert.match(out.reason, /only the header moved/i);
  for (const name of ['CURRENT STATE', 'NEXT ACTIONS', 'KEY FILES']) {
    assert.ok(out.reason.includes(name), `reason names ${name}`);
  }
  assert.ok(readPreImage(sid, { _dir: dir }), 'pre-image kept so the retry is judged against the same round');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  assert.equal(db[sid].lastLiveHash, undefined);
  assert.equal(db[sid].lastStateStampMs, undefined);
});

test('S3: a lint failure blocks with at most five lint errors', () => {
  const cwd = tmpDir();
  const sid = 'sid-s3';
  const statePath = ownStatePath(cwd, sid);
  const body = ['---', 'session: x', '---', '', '## OBJECTIVE', 'only this', ''].join('\n');
  fs.writeFileSync(statePath, body, 'utf8');
  const { errors } = lintState(body, {});
  assert.ok(errors.length > 5, 'fixture must fail more than five rules');

  const out = run(cwd, sid, { db: path.join(tmpDir(), 'state.json'), dir: tmpDir() });

  assert.ok(out && out.reason);
  assert.match(out.reason, /lint/i);
  for (const e of errors.slice(0, 5)) assert.ok(out.reason.includes(e), `reason lists: ${e}`);
  assert.ok(!out.reason.includes(errors[5]), 'only the first five errors are shown');
});

test('S4: every block reason names the seven sections', () => {
  const notes = [
    buildStopNudge({ edits: 12, commits: 1 }),
    buildStopNudge({ cause: 'header-only', since: '2026-11-18 02:00 UTC' }),
    buildStopNudge({ cause: 'lint', errors: ['saved: not the clock form — fix: run stampState'] }),
  ];
  for (const note of notes) {
    for (const name of SECTIONS) assert.ok(note.includes(name), `reason names ${name}`);
  }
});

test('S5: a ruling alone does not nudge; a ruling plus threshold-1 edits does', () => {
  const now = 1_000_000;
  assert.equal(decideStopNudge({ edits: 0, commits: 0, rulings: 1, lastNudgeTs: 0, now }), false);
  assert.equal(decideStopNudge({ edits: EDIT_NUDGE_THRESHOLD - 1, commits: 0, rulings: 1, lastNudgeTs: 0, now }), true);
});

test('S6: the round pre-image lets a multi-Edit checkpoint stand down; the header-only edit alone blocks', () => {
  const cwd = tmpDir();
  const sid = 'sid-s6';
  const statePath = ownStatePath(cwd, sid);
  fs.writeFileSync(statePath, stateBody({ current: 'Base state.' }), 'utf8');
  const dir = tmpDir();
  const dbPath = path.join(tmpDir(), 'state.json');

  // Edit 1 is header-only; the guard records the pre-image before it lands.
  const allowed = onPreToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: statePath } },
    { _dir: dir, _ownStatePath: statePath, _env: {} },
  );
  assert.equal(allowed, null);
  fs.writeFileSync(statePath, stateBody({ resume: 'Do the next', current: 'Base state.' }), 'utf8');

  const first = run(cwd, sid, { db: dbPath, dir });
  assert.ok(first && first.reason);
  assert.match(first.reason, /only the header moved/i);

  // Edit 2 moves NEXT ACTIONS in the same round: the Stop now stands down.
  fs.writeFileSync(statePath, stateBody({
    resume: 'Do the next', current: 'Base state.', next: '1. Do the next\n2. Then the other thing',
  }), 'utf8');
  assert.equal(run(cwd, sid, { db: dbPath, dir }), null);
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  assert.equal(db[sid].lastStateStampMs, Date.UTC(2026, 10, 18, 2, 0, 0));
});

test('S7: the sid\'s newest file is judged, not the skeleton beside it', () => {
  const cwd = tmpDir();
  const sid = 'sid-s7';
  const dir = projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const skeleton = path.join(dir, `STATE_${sid}_20261118T010000Z.md`);
  const rich = path.join(dir, `STATE_task_${sid}_20261118T020000Z.md`);
  fs.writeFileSync(skeleton, 'Skeletal backstop written by `pre-compact-snapshot.mjs`\n', 'utf8');
  fs.writeFileSync(rich, stateBody({ current: 'Rich current state.' }), 'utf8');

  const dbPath = path.join(tmpDir(), 'state.json');
  fs.writeFileSync(dbPath, JSON.stringify({
    [sid]: {
      lastStateStampMs: 0,
      lastLiveHash: liveSectionsHash(stateBody({ current: 'Older rich state.' })),
    },
  }), 'utf8');

  const out = run(cwd, sid, { db: dbPath, dir: tmpDir() });

  assert.equal(out, null, 'the rich file passes and moved');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  assert.equal(db[sid].lastStateStampMs, Date.UTC(2026, 10, 18, 2, 0, 0),
    'judged the T02 file, not the T01 skeleton');
});

test('judgeCheckpoint: skips the live-hash rule when there is no pre-image and no last hash', () => {
  const verdict = judgeCheckpoint({ text: stateBody() });
  assert.equal(verdict.standDown, true);
  assert.equal(verdict.cause, 'moved');
});
