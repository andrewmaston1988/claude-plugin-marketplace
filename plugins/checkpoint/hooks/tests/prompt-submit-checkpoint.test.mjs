import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveUtilisation, buildCheckpointNudge, TTL_NOTES } from '../prompt-submit-checkpoint.mjs';
import { resolveTtlSource } from '../lib/cadence.mjs';

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
  // Must name the qualified skill id, not bare "checkpoint" — bare collides with
  // the CLI's built-in checkpoint/rewind and agents reach for that instead.
  assert.match(note, /skill="checkpoint:checkpoint"/);
  assert.match(note, /not the built-in checkpoint\/rewind/i);
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

// The 2026-07-16 refusal, part 1: a defaulted TTL presented as "detected" reads
// as stale detection and gets the whole injection distrusted.
test('keepalive-init template states TTL provenance via {ttlNote}, never a hardcoded claim', () => {
  const tmpl = fs.readFileSync(new URL('../templates/keepalive-init.md', import.meta.url), 'utf8');
  assert.match(tmpl, /\{ttlNote\}/);
  assert.doesNotMatch(tmpl, /TTL \(detected from the cache-bucket usage/);
});

// The 2026-07-16 refusal, part 2: the Fable 5 ScheduleWakeup contract forbids
// cache-warming wakeups; without an explicit answer, compliant models decline.
test('keepalive-init template answers the ScheduleWakeup no-cache-warming contract', () => {
  const tmpl = fs.readFileSync(new URL('../templates/keepalive-init.md', import.meta.url), 'utf8');
  assert.match(tmpl, /operator-configured, opt-in/i);
  assert.match(tmpl, /past/i); // the chain extends the cache PAST its TTL — the case the contract ignores
  assert.match(tmpl, /operator-opted-in cache keepalive/); // reason string says what it really is
});

test('every resolveTtlSource source has a TTL_NOTES entry', () => {
  const h1 = [{ cache_creation: { ephemeral_1h_input_tokens: 412, ephemeral_5m_input_tokens: 0 } }];
  const cases = [[1800, [], null], [null, h1, null], [null, [], 3600], [null, [{}], null]];
  for (const [forced, usages, last] of cases) {
    const { source } = resolveTtlSource(forced, usages, last);
    assert.ok(TTL_NOTES[source], `missing TTL_NOTES entry for source "${source}"`);
  }
});
