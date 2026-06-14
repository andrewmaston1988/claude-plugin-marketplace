import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextDelay, keepaliveAction,
  FIRST_DELAY_SECS, MIN_DELAY_SECS, MAX_DELAY_SECS,
} from '../lib/cadence.mjs';

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
