import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanWorkSignals, decideStopNudge, buildStopNudge, stateStampMs, judgeCheckpoint, runStop,
  EDIT_NUDGE_THRESHOLD, NUDGE_COOLDOWN_MS,
} from '../stop-checkpoint.mjs';
import { SECTIONS, lintState, liveSectionsHash } from '../lib/state-lint.mjs';
import { onPostToolUse, onPreToolUse, preImagePath, readPreImage } from '../lib/state-guard.mjs';

function line(obj) { return JSON.stringify(obj) + '\n'; }

function assistantToolUse(name, input = {}, id) {
  return line({
    message: { role: 'assistant', content: [{ type: 'tool_use', name, input, ...(id ? { id } : {}) }] },
  });
}

function toolResult(id) {
  return line({
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'yes' }] },
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

test('scanWorkSignals: counts only an ANSWERED AskUserQuestion as a ruling', () => {
  const answered = assistantToolUse('AskUserQuestion', { questions: [{ question: 'Which?' }] }, 'q1')
    + toolResult('q1');
  assert.deepEqual(scanWorkSignals(answered), { edits: 0, commits: 0, rulings: 1 });

  const unanswered = assistantToolUse('AskUserQuestion', { questions: [{ question: 'Which?' }] }, 'q2');
  assert.equal(scanWorkSignals(unanswered).rulings, 0, 'a question with no answer ruled nothing');

  const otherResult = assistantToolUse('AskUserQuestion', { questions: [] }, 'q3') + toolResult('different');
  assert.equal(scanWorkSignals(otherResult).rulings, 0, 'a result for another call does not count');
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

// Everything a stop-hook test needs, under one temp root cleaned up with the
// test: nothing here may touch the operator's ~/.claude.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-cp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'nudge');
  fs.mkdirSync(dir, { recursive: true });
  return {
    root,
    cwd: path.join(root, 'repo'),
    dir,
    db: path.join(root, 'state.json'),
    transcript(signals = '') {
      const p = path.join(root, `tx-${Math.random().toString(36).slice(2)}.jsonl`);
      fs.writeFileSync(p, signals, 'utf8');
      return p;
    },
    statePath(sid, { stamp = '20261118T020000Z', body } = {}) {
      const p = path.join(root, 'states', `STATE_${sid}_${stamp}.md`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (body !== undefined) fs.writeFileSync(p, body, 'utf8');
      return p;
    },
  };
}

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

function run(f, sid, { signals = '', ownStatePath } = {}) {
  assert.ok(ownStatePath, 'inject the own STATE path — never resolve through the real home');
  return runStop(
    { session_id: sid, cwd: f.cwd, transcript_path: f.transcript(signals) },
    // Empty env: the ambient CORRELATION_ID would skip every headless session.
    {
      _db: f.db, _dir: f.dir, _settings: {}, _env: {},
      _now: () => Date.UTC(2026, 10, 18, 2, 5, 0), _ownStatePath: ownStatePath,
    },
  );
}

test('S1: a moved live hash stands down, stores lastLiveHash and clears the pre-image', (t) => {
  const f = fixture(t);
  const sid = 'sid-s1';
  const statePath = f.statePath(sid, { body: stateBody({ current: 'New state.' }) });
  fs.writeFileSync(preImagePath(sid, f.dir), JSON.stringify({
    hash: liveSectionsHash(stateBody({ current: 'Old state.' })),
    path: statePath,
    ts: Date.UTC(2026, 10, 18, 1, 0, 0),
  }), 'utf8');

  const out = run(f, sid, { ownStatePath: statePath });

  assert.equal(out, null, 'no block');
  const db = JSON.parse(fs.readFileSync(f.db, 'utf8'));
  assert.equal(db[sid].lastLiveHash, liveSectionsHash(stateBody({ current: 'New state.' })));
  assert.equal(db[sid].lastStateStampMs, Date.UTC(2026, 10, 18, 2, 0, 0));
  assert.equal(readPreImage(sid, { _dir: f.dir }), null, 'pre-image cleared on stand-down');
});

test('S2: a header-only round blocks with the header-only reason', (t) => {
  const f = fixture(t);
  const sid = 'sid-s2';
  const live = stateBody({ current: 'Same live state.' });
  const statePath = f.statePath(sid, { body: live });
  fs.writeFileSync(preImagePath(sid, f.dir), JSON.stringify({
    hash: liveSectionsHash(live), path: statePath, ts: Date.UTC(2026, 10, 18, 1, 0, 0),
  }), 'utf8');

  const out = run(f, sid, { ownStatePath: statePath });

  assert.ok(out && out.reason);
  assert.match(out.reason, /only the header moved/i);
  for (const name of ['CURRENT STATE', 'NEXT ACTIONS', 'KEY FILES']) {
    assert.ok(out.reason.includes(name), `reason names ${name}`);
  }
  assert.ok(readPreImage(sid, { _dir: f.dir }), 'pre-image kept so the retry is judged against the same round');
  const db = JSON.parse(fs.readFileSync(f.db, 'utf8'));
  assert.equal(db[sid].lastLiveHash, undefined);
  assert.equal(db[sid].lastStateStampMs, undefined);
});

test('S3: a lint failure blocks with at most five lint errors', (t) => {
  const f = fixture(t);
  const sid = 'sid-s3';
  const body = ['---', 'session: x', '---', '', '## OBJECTIVE', 'only this', ''].join('\n');
  const statePath = f.statePath(sid, { body });
  const { errors } = lintState(body, {});
  assert.ok(errors.length > 5, 'fixture must fail more than five rules');

  const out = run(f, sid, { ownStatePath: statePath });

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

test('S6: the round pre-image lets a multi-Edit checkpoint stand down; the header-only edit alone blocks', (t) => {
  const f = fixture(t);
  const sid = 'sid-s6';
  const statePath = f.statePath(sid, { body: stateBody({ current: 'Base state.' }) });

  // Edit 1 is header-only; the guard records the pre-image before it lands.
  const edit = () => {
    assert.equal(onPreToolUse(
      { session_id: sid, cwd: f.cwd, tool_name: 'Edit', tool_input: { file_path: statePath } },
      { _dir: f.dir, _ownStatePath: statePath, _env: {} },
    ), null);
  };
  const wrote = () => onPostToolUse(
    { session_id: sid, tool_name: 'Edit', tool_input: { file_path: statePath } },
    { _dir: f.dir, _env: {} },
  );
  edit();
  fs.writeFileSync(statePath, stateBody({ resume: 'Do the next', current: 'Base state.' }), 'utf8');
  assert.equal(wrote(), null);

  const first = run(f, sid, { ownStatePath: statePath });
  assert.ok(first && first.reason);
  assert.match(first.reason, /only the header moved/i);

  // Edit 2 moves NEXT ACTIONS in the same round: the Stop now stands down.
  edit();
  fs.writeFileSync(statePath, stateBody({
    resume: 'Do the next', current: 'Base state.', next: '1. Do the next\n2. Then the other thing',
  }), 'utf8');
  assert.equal(wrote(), null);
  assert.equal(run(f, sid, { ownStatePath: statePath }), null);
  const db = JSON.parse(fs.readFileSync(f.db, 'utf8'));
  assert.equal(db[sid].lastStateStampMs, Date.UTC(2026, 10, 18, 2, 0, 0));
});

test('S7: the sid\'s newest file is judged, not the skeleton beside it', (t) => {
  const f = fixture(t);
  const sid = 'sid-s7';
  f.statePath(sid, { stamp: '20261118T010000Z', body: 'Skeletal backstop written by `pre-compact-snapshot.mjs`\n' });
  const rich = f.statePath(`task_${sid}`, { stamp: '20261118T020000Z', body: stateBody({ current: 'Rich current state.' }) });

  fs.writeFileSync(f.db, JSON.stringify({
    [sid]: {
      lastStateStampMs: 0,
      lastLiveHash: liveSectionsHash(stateBody({ current: 'Older rich state.' })),
    },
  }), 'utf8');

  const out = run(f, sid, { ownStatePath: rich });

  assert.equal(out, null, 'the rich file passes and moved');
  const db = JSON.parse(fs.readFileSync(f.db, 'utf8'));
  assert.equal(db[sid].lastStateStampMs, Date.UTC(2026, 10, 18, 2, 0, 0),
    'judged the T02 file, not the T01 skeleton');
});

test('judgeCheckpoint: skips the live-hash rule when there is no pre-image and no last hash', () => {
  const verdict = judgeCheckpoint({ text: stateBody() });
  assert.equal(verdict.standDown, true);
  assert.equal(verdict.cause, 'moved');
});
