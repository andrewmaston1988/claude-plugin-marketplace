import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFreshSession, shouldOffer, relativeAge } from '../session-start-resume.mjs';

test('isFreshSession: startup and clear are fresh; resume and compact are not', () => {
  assert.equal(isFreshSession('startup'), true);
  assert.equal(isFreshSession('clear'), true);
  assert.equal(isFreshSession('resume'), false);
  assert.equal(isFreshSession('compact'), false);
});

test('shouldOffer: only when fresh, enabled, not correlation, and STATE exists', () => {
  const base = { source: 'startup', enabled: true, correlation: false, stateExists: true };
  assert.equal(shouldOffer(base), true);
  assert.equal(shouldOffer({ ...base, source: 'resume' }), false);
  assert.equal(shouldOffer({ ...base, enabled: false }), false);
  assert.equal(shouldOffer({ ...base, correlation: true }), false);
  assert.equal(shouldOffer({ ...base, stateExists: false }), false);
});

test('relativeAge formats minutes, hours, days', () => {
  const now = 1_000_000_000_000;
  assert.equal(relativeAge(now - 120_000, now), '2m ago');
  assert.equal(relativeAge(now - 7_200_000, now), '2h ago');
  assert.equal(relativeAge(now - 172_800_000, now), '2d ago');
});
