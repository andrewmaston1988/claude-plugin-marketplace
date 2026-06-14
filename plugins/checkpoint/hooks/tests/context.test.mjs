import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contextWindowFor, usageInputTotal, contextUtilization,
  decideCheckpointNudge, cacheState, detectCacheBust,
  CONTEXT_NUDGE_PCT,
} from '../lib/context.mjs';

const warm   = { input_tokens: 200, cache_creation_input_tokens: 500, cache_read_input_tokens: 150000 };
const busted = { input_tokens: 200, cache_creation_input_tokens: 150000, cache_read_input_tokens: 0 };

test('contextWindowFor maps known models and defaults to 200k', () => {
  assert.equal(contextWindowFor('claude-opus-4-8'), 200000);
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

test('decideCheckpointNudge fires at threshold, re-fires on +10pp', () => {
  assert.equal(decideCheckpointNudge(74, null), false);
  assert.equal(decideCheckpointNudge(75, null), true);
  assert.equal(decideCheckpointNudge(80, 75), false); // only +5pp
  assert.equal(decideCheckpointNudge(85, 75), true);  // +10pp
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

test('threshold constant is 75', () => {
  assert.equal(CONTEXT_NUDGE_PCT, 75);
});
