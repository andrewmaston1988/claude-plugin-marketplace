import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUtilisation, buildCheckpointNudge } from '../prompt-submit-checkpoint.mjs';

test('resolveUtilisation: usage path wins when present', () => {
  const turns = [{ model: 'claude-opus-4-8', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 160000 } }];
  const { pct, source } = resolveUtilisation(turns, /*bytes*/ 0);
  assert.equal(pct, 80);
  assert.equal(source, 'usage');
});

test('resolveUtilisation: falls back to bytes when no usage', () => {
  const { pct, source } = resolveUtilisation([], /*bytes*/ 2_500_000);
  assert.equal(source, 'bytes');
  assert.ok(pct >= 75); // 2.5MB -> 75 + floor((2.5M-2M)/200k) = 77%, over the 75 nudge threshold
});

test('buildCheckpointNudge mentions the checkpoint skill and the pct', () => {
  const note = buildCheckpointNudge(82);
  assert.match(note, /\*\*checkpoint\*\* skill/i);
  assert.match(note, /82%/);
  assert.doesNotMatch(note, /## 1\. OBJECTIVE/); // must NOT inline the template
});
