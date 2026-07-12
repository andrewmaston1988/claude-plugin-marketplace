import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextDelay, keepaliveAction, cadenceFor, ttlFromUsage, resolveTtl,
  FIRST_DELAY_SECS, MIN_DELAY_SECS, MAX_DELAY_SECS,
  TARGET_CADENCE_SECS, KEEPALIVE_CHAIN_DEAD_SECS, KEEPALIVE_IDLE_STOP_SECS,
} from '../lib/cadence.mjs';

test('cadenceFor(300) reproduces the reference constants', () => {
  const c = cadenceFor(300);
  assert.equal(c.ttlSecs, 300);
  assert.equal(c.targetSecs, TARGET_CADENCE_SECS);      // 255
  assert.equal(c.firstDelaySecs, FIRST_DELAY_SECS);     // 240
  assert.equal(c.minDelaySecs, MIN_DELAY_SECS);         // 180
  assert.equal(c.maxDelaySecs, MAX_DELAY_SECS);         // 270
  assert.equal(c.chainDeadSecs, KEEPALIVE_CHAIN_DEAD_SECS); // 240
  assert.equal(c.idleStopSecs, KEEPALIVE_IDLE_STOP_SECS);   // 3600
});

test('cadenceFor(3600) scales proportionally; idle-stop covers an overnight hold', () => {
  const c = cadenceFor(3600);
  assert.equal(c.targetSecs, 3060);
  assert.equal(c.firstDelaySecs, 2880);
  assert.equal(c.minDelaySecs, 2160);
  assert.equal(c.maxDelaySecs, 3240);
  assert.equal(c.chainDeadSecs, 2880);
  assert.equal(c.idleStopSecs, 43200); // 12h > the 8h sleep scenario
});

test('cadenceFor clamps delay fields into ScheduleWakeup [60, 3600]', () => {
  const tiny = cadenceFor(60);
  assert.equal(tiny.minDelaySecs, 60);   // 36 -> clamped up
  assert.equal(tiny.firstDelaySecs, 60); // 48 -> clamped up
  const huge = cadenceFor(7200);
  assert.equal(huge.targetSecs, 3600);   // 6120 -> capped at wakeup max
  assert.equal(huge.maxDelaySecs, 3600);
  assert.equal(huge.idleStopSecs, 86400); // not a wakeup delay — unclamped
});

test('cadenceFor falls back to 300 on missing/invalid ttl', () => {
  assert.equal(cadenceFor().ttlSecs, 300);
  assert.equal(cadenceFor(null).ttlSecs, 300);
  assert.equal(cadenceFor(NaN).ttlSecs, 300);
  assert.equal(cadenceFor(-5).ttlSecs, 300);
});

test('cadenceFor honours an idleStopSecs override', () => {
  assert.equal(cadenceFor(300, { idleStopSecs: 28800 }).idleStopSecs, 28800);
  assert.equal(cadenceFor(3600, { idleStopSecs: 7200 }).idleStopSecs, 7200);
});

test('ttlFromUsage picks the live bucket from cache_creation', () => {
  assert.equal(ttlFromUsage({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 412 } }), 3600);
  assert.equal(ttlFromUsage({ cache_creation: { ephemeral_5m_input_tokens: 99, ephemeral_1h_input_tokens: 0 } }), 300);
  // mixed buckets: any 5m write means 5m-expiring content — prefer the short TTL
  assert.equal(ttlFromUsage({ cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 400 } }), 300);
});

test('ttlFromUsage returns null when the row carries no bucket signal', () => {
  assert.equal(ttlFromUsage(null), null);
  assert.equal(ttlFromUsage({}), null);
  assert.equal(ttlFromUsage({ cache_creation: {} }), null);
  assert.equal(ttlFromUsage({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }), null);
});

test('resolveTtl: forced override wins over usage evidence', () => {
  const usages = [{ cache_creation: { ephemeral_1h_input_tokens: 412, ephemeral_5m_input_tokens: 0 } }];
  assert.equal(resolveTtl(1800, usages, null), 1800);
});

test('resolveTtl: newest usage row with a bucket signal wins', () => {
  const usages = [
    { cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 } },
    { cache_creation: { ephemeral_1h_input_tokens: 412, ephemeral_5m_input_tokens: 0 } },
    { cache_creation: {} }, // pure cache-hit turn — no signal, skip back
  ];
  assert.equal(resolveTtl(null, usages, null), 3600);
});

test('resolveTtl: falls back to last known, then 300', () => {
  assert.equal(resolveTtl(null, [], 3600), 3600);
  assert.equal(resolveTtl(null, [{}], null), 300);
});

test('nextDelay and keepaliveAction accept a cadence override', () => {
  const c = cadenceFor(3600);
  assert.equal(nextDelay(null, null, c), 2880);
  assert.equal(nextDelay(3300, 3060, c), 2820); // overshoot 240 -> 3060 - 240
  assert.equal(nextDelay(9999, 3060, c), 2160); // clamps at scaled min
  // 4000s user idle stops the default chain but not a 1h-bucket chain
  assert.equal(keepaliveAction(4000, 10, false), 'stop');
  assert.equal(keepaliveAction(4000, 10, false, c), 'none');
  assert.equal(keepaliveAction(50000, 10, false, c), 'stop');
  assert.equal(keepaliveAction(4000, 3000, false, c), 'inject'); // chain dead at 2880
});

test('first tick (no history) uses FIRST_DELAY_SECS', () => {
  assert.equal(nextDelay(null, null), FIRST_DELAY_SECS);
  assert.equal(nextDelay(0, 0), FIRST_DELAY_SECS);
});

test('overshoot pulls the next delay down', () => {
  // injected 255s, realized 285s -> overshoot 30 -> 255 - 30 = 225
  assert.equal(nextDelay(285, 255), 225);
});

test('clamps below MIN', () => {
  assert.equal(nextDelay(600, 255), MIN_DELAY_SECS);
});

test('never exceeds MAX', () => {
  // zero overshoot -> target 255, which is <= MAX 270
  assert.equal(nextDelay(255, 255), 255);
  assert.ok(nextDelay(10, 255) <= MAX_DELAY_SECS);
});

test('keepaliveAction: stop after long real user idle', () => {
  assert.equal(keepaliveAction(4000, 10, false), 'stop');
});

test('keepaliveAction: no stop when no prior user data', () => {
  // Infinity idle == "never seen a user prompt", treat as fresh, not gone
  assert.notEqual(keepaliveAction(Infinity, Infinity, false), 'stop');
});

test('keepaliveAction: inject on a tick', () => {
  assert.equal(keepaliveAction(10, 10, true), 'inject');
});

test('keepaliveAction: inject when chain is dead', () => {
  assert.equal(keepaliveAction(10, 300, false), 'inject');
});

test('keepaliveAction: no-op when warm and recent', () => {
  assert.equal(keepaliveAction(10, 10, false), 'none');
});
