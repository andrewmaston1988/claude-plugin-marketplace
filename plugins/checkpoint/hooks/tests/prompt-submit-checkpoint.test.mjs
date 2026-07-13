import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveUtilisation, buildCheckpointNudge } from '../prompt-submit-checkpoint.mjs';

test('resolveUtilisation: usage path wins when present', () => {
  const turns = [{ model: 'claude-sonnet-4-5', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 160000 } }];
  const { pct, source } = resolveUtilisation(turns, /*bytes*/ 0);
  assert.equal(pct, 80);
  assert.equal(source, 'usage');
});

test('resolveUtilisation: 1M-window models compute against 1M', () => {
  const turns = [{ model: 'claude-opus-4-8', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 160000 } }];
  const { pct } = resolveUtilisation(turns, 0);
  assert.equal(pct, 16);
});

test('resolveUtilisation: falls back to bytes when no usage', () => {
  const { pct, source } = resolveUtilisation([], /*bytes*/ 2_500_000);
  assert.equal(source, 'bytes');
  assert.ok(pct >= 75); // 2.5MB -> 75 + floor((2.5M-2M)/200k) = 77%, over the 75 nudge threshold
});

test('buildCheckpointNudge frames a handover, not a stop-work order', () => {
  const note = buildCheckpointNudge(87);
  assert.match(note, /\*\*checkpoint\*\* skill/i);
  assert.match(note, /87%/);
  assert.match(note, /handover/i);
  assert.match(note, /no need to stop/i);
  assert.doesNotMatch(note, /## 1\. OBJECTIVE/); // must NOT inline the template
});

test('keepalive-init template does not hand the model an excuse to skip', () => {
  const tmpl = fs.readFileSync(new URL('../templates/keepalive-init.md', import.meta.url), 'utf8');
  assert.doesNotMatch(tmpl, /\*\*Skip this\*\*/i);
  assert.match(tmpl, /even if you are mid-task/i);
});
