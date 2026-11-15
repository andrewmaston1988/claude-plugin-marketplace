import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contextWindowFor, usageInputTotal, contextUtilization,
  decideCheckpointNudge, cacheState, detectCacheBust,
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

test('contextWindowFor: a [1m] suffix means 1M whatever the family', () => {
  assert.equal(contextWindowFor('claude-sonnet-5[1m]'), 1000000);
  assert.equal(contextWindowFor('claude-opus-5-5[1m]'), 1000000);
});

test('usageInputTotal sums the three input-side fields', () => {
  assert.equal(usageInputTotal(warm), 150700);
  assert.equal(usageInputTotal(null), 0);
});

test('contextUtilization is a rounded percentage', () => {
  assert.equal(contextUtilization({ input_tokens: 100000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, 200000), 50);
});

// T 467,000 with the 60k default reserve: soon at 347,000, now at 407,000.
const T = 467_000;
const RESERVE = 60_000;
const decide = (used, state) => decideCheckpointNudge({ used, trigger: T, reserve: RESERVE, state });

test('decideCheckpointNudge: soon then now in one cycle; a jump fires now only', () => {
  const first = decide(347_000);
  assert.equal(first.band, 'soon');
  assert.deepEqual(first.state.fired, ['soon']);
  const second = decide(407_000, first.state);
  assert.equal(second.band, 'now');
  assert.deepEqual(second.state.fired, ['soon', 'now']);
  assert.equal(second.state.cycle, first.state.cycle);
  assert.equal(decide(460_000, second.state).band, null);

  const jump = decide(407_000);
  assert.equal(jump.band, 'now');
  assert.deepEqual(jump.state.fired, ['now']);
  assert.equal(decide(460_000, jump.state).band, null);
});

test('decideCheckpointNudge: a drop below soon starts a new cycle', () => {
  const a = decide(350_000);
  assert.equal(a.band, 'soon');
  const b = decide(200_000, a.state);
  assert.equal(b.band, null);
  assert.deepEqual(b.state.fired, []);
  assert.equal(b.state.cycle, a.state.cycle + 1);
  const c = decide(350_000, b.state);
  assert.equal(c.band, 'soon');
  assert.equal(decide(410_000, c.state).band, 'now');
});

test('decideCheckpointNudge: a changed trigger starts a new cycle', () => {
  const { band, state } = decideCheckpointNudge({
    used: 100_000, trigger: 167_000, reserve: RESERVE,
    state: { trigger: T, cycle: 3, fired: ['now'] },
  });
  assert.equal(band, 'soon');
  assert.equal(state.trigger, 167_000);
  assert.equal(state.cycle, 4);
  assert.deepEqual(state.fired, ['soon']);
});

test('decideCheckpointNudge: the reserve is clamped to T/4, keeping soon at or above T/2', () => {
  const t = 67_000; // r = 16,750 -> soon 33,500, now 50,250
  const band = (used, reserve) => decideCheckpointNudge({ used, trigger: t, reserve }).band;
  assert.equal(band(33_499, 10_000_000), null);
  assert.equal(band(33_500, 10_000_000), 'soon');
  assert.equal(band(50_249, 10_000_000), 'soon');
  assert.equal(band(50_250, 10_000_000), 'now');
  // An unclamped reserve would put both lines far below zero.
  assert.equal(band(66_998, 1), 'soon');
  assert.equal(band(66_999, 1), 'now');
});

test('decideCheckpointNudge: a custom reserve moves both lines', () => {
  const band = (used, reserve) => decideCheckpointNudge({ used, trigger: T, reserve }).band;
  assert.equal(band(406_999, RESERVE), 'soon');
  assert.equal(band(406_999, 30_000), null);
  assert.equal(band(407_000, 30_000), 'soon');
  assert.equal(band(437_000, 30_000), 'now');
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
