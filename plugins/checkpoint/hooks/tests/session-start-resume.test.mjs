import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isFreshSession, shouldOffer, relativeAge, renderResumeOffer,
} from '../session-start-resume.mjs';

test('isFreshSession: startup and clear are fresh; resume and compact are not', () => {
  assert.equal(isFreshSession('startup'), true);
  assert.equal(isFreshSession('clear'), true);
  assert.equal(isFreshSession('resume'), false);
  assert.equal(isFreshSession('compact'), false);
});

test('shouldOffer: true on a fresh, enabled, non-correlated start — regardless of STATE existence', () => {
  // The previous gate required stateExists; the new behaviour always offers on
  // a fresh start so the agent is taught how to find the handoff even when no
  // file was present at hook-fire time (or when the user asks to resume later).
  const base = { source: 'startup', enabled: true, correlation: false };
  assert.equal(shouldOffer(base), true);
  assert.equal(shouldOffer({ ...base, source: 'clear' }), true);
  assert.equal(shouldOffer({ ...base, source: 'resume' }), false);
  assert.equal(shouldOffer({ ...base, source: 'compact' }), false);
  assert.equal(shouldOffer({ ...base, enabled: false }), false);
  assert.equal(shouldOffer({ ...base, correlation: true }), false);
});

test('shouldOffer: ignores stateExists (legacy arg is silently dropped)', () => {
  const base = { source: 'startup', enabled: true, correlation: false };
  // The legacy stateExists field is no longer part of the contract — even if
  // a caller still passes it (or passes stateExists:false), the offer still
  // fires when the other gates pass.
  assert.equal(shouldOffer({ ...base, stateExists: true }), true);
  assert.equal(shouldOffer({ ...base, stateExists: false }), true);
});

test('relativeAge formats minutes, hours, days', () => {
  const now = 1_000_000_000_000;
  assert.equal(relativeAge(now - 120_000, now), '2m ago');
  assert.equal(relativeAge(now - 7_200_000, now), '2h ago');
  assert.equal(relativeAge(now - 172_800_000, now), '2d ago');
});

// ---- renderResumeOffer: template behaviour ----

// Read the template fresh from disk so the test exercises the actual shipped
// copy, not a duplicated inline string (single source of truth).
function loadTemplate() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.join(here, '..', 'templates', 'resume-offer.md'), 'utf8');
}

test('renderResumeOffer: no STATE file → still emits the find-instructions with the project dir', () => {
  const tmpl = loadTemplate();
  const out = renderResumeOffer({
    template: tmpl,
    dir: '/home/u/.claude/projects/C--foo',
    statePath: '',
    mtimeMs: 0,
    now: 1_000_000_000_000,
  });
  // Always-actionable: the agent must know where to look and how to pick a file.
  assert.match(out, /STATE handoffs for this directory live in/);
  assert.match(out, /\/home\/u\/\.claude\/projects\/C--foo/);
  assert.match(out, /newest `STATE\*\.md`/);
  assert.match(out, /plain `STATE\.md`/);
  // No "Current best match" line when no file was found.
  assert.doesNotMatch(out, /Current best match/);
});

test('renderResumeOffer: with a STATE file → adds a current-best-match line with path + age', () => {
  const tmpl = loadTemplate();
  const now = 1_000_000_000_000;
  const out = renderResumeOffer({
    template: tmpl,
    dir: '/home/u/.claude/projects/C--foo',
    statePath: '/home/u/.claude/projects/C--foo/STATE_sid_20260625T030000Z.md',
    mtimeMs: now - 120_000,
    now,
  });
  assert.match(out, /Current best match: `\/home\/u\/\.claude\/projects\/C--foo\/STATE_sid_20260625T030000Z\.md` \(from 2m ago\)\./);
  // The find-instructions are still present — the path is additive, not a replacement.
  assert.match(out, /newest `STATE\*\.md`/);
});

test('renderResumeOffer: empty dir is tolerated (no throw, blank where dir should be)', () => {
  const tmpl = loadTemplate();
  const out = renderResumeOffer({ template: tmpl, dir: '', statePath: '', mtimeMs: 0 });
  assert.match(out, /STATE handoffs for this directory live in ``\./);
  assert.doesNotMatch(out, /Current best match/);
});
