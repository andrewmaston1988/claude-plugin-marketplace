import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanWorkSignals, decideStopNudge, buildStopNudge, stateStampMs,
  EDIT_NUDGE_THRESHOLD, NUDGE_COOLDOWN_MS,
} from '../stop-checkpoint.mjs';

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
  assert.deepEqual(scanWorkSignals(text), { edits: 0, commits: 0 });
  assert.deepEqual(scanWorkSignals(''), { edits: 0, commits: 0 });
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
  assert.match(note, /\*\*checkpoint\*\* skill/i);
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
