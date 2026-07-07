import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contextWindowFor, usageInputTotal, contextUtilization,
  decideCheckpointNudge, cacheState, detectCacheBust,
  CONTEXT_NUDGE_BANDS,
} from '../lib/context.mjs';

const warm   = { input_tokens: 200, cache_creation_input_tokens: 500, cache_read_input_tokens: 150000 };
const busted = { input_tokens: 200, cache_creation_input_tokens: 150000, cache_read_input_tokens: 0 };

test('contextWindowFor maps model families and defaults to 200k', () => {
  assert.equal(contextWindowFor('claude-opus-4-8'), 1000000);
  assert.equal(contextWindowFor('claude-opus-5'), 1000000);
  assert.equal(contextWindowFor('claude-fable-5'), 1000000);
  assert.equal(contextWindowFor('claude-sonnet-4-5'), 200000);
  assert.equal(contextWindowFor('claude-sonnet-5'), 200000);
  assert.equal(contextWindowFor('claude-haiku-4-5-20251001'), 200000);
  assert.equal(contextWindowFor('something-unknown'), 200000);
  assert.equal(contextWindowFor(undefined), 200000);
});

test('usageInputTotal sums the three input-side fields', () => {
  assert.equal(usageInputTotal(warm), 150700);
  assert.equal(usageInputTotal(null), 0);
});

test('contextUtilization is a rounded percentage', () => {
  assert.equal(contextUtilization({ input_tokens: 100000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, 200000), 50);
});

test('decideCheckpointNudge fires at 85 and 95 bands, resets when utilisation falls', () => {
  assert.equal(decideCheckpointNudge(84, null), false);
  assert.equal(decideCheckpointNudge(85, null), true);
  assert.equal(decideCheckpointNudge(90, 86), false);  // 85 band already fired this cycle
  assert.equal(decideCheckpointNudge(95, 86), true);   // 95 band
  assert.equal(decideCheckpointNudge(97, 95), false);  // nothing above 95
  assert.equal(decideCheckpointNudge(40, 95), false);  // post-compact, below all bands
  assert.equal(decideCheckpointNudge(85, 95), true);   // pct fell below lastFired -> new cycle -> 85 fires again
});

test('cacheState: warm vs busted vs cold', () => {
  assert.equal(cacheState(warm), 'warm');
  assert.equal(cacheState(busted), 'busted');
  assert.equal(cacheState(null), 'cold');
  assert.equal(cacheState({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }), 'cold');
});

test('detectCacheBust: only when prior warm and current busted with big creation', () => {
  assert.equal(detectCacheBust(busted, warm), true);   // was warm, now busted
  assert.equal(detectCacheBust(busted, busted), false); // cold start / already cold, not a fresh bust
  assert.equal(detectCacheBust(warm, warm), false);    // stayed warm
  assert.equal(detectCacheBust(null, warm), false);
});

test('nudge bands are 85 and 95', () => {
  assert.deepEqual(CONTEXT_NUDGE_BANDS, [85, 95]);
});
