import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isFreshSession, shouldOffer, longAge, optionLabel, renderResumeOffer,
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
  assert.equal(shouldOffer({ ...base, stateExists: true }), true);
  assert.equal(shouldOffer({ ...base, stateExists: false }), true);
});

const NOW = 1_000_000_000_000;

test('longAge spells the unit out and singularises', () => {
  assert.equal(longAge(NOW - 30_000, NOW), 'just now');
  assert.equal(longAge(NOW - 60_000, NOW), '1 minute ago');
  assert.equal(longAge(NOW - 120_000, NOW), '2 minutes ago');
  assert.equal(longAge(NOW - 3_600_000, NOW), '1 hour ago');
  assert.equal(longAge(NOW - 7_200_000, NOW), '2 hours ago');
  assert.equal(longAge(NOW - 86_400_000, NOW), '1 day ago');
  assert.equal(longAge(NOW - 172_800_000, NOW), '2 days ago');
});

test('optionLabel reads as an operator-facing choice, falling back to the sid', () => {
  assert.equal(
    optionLabel({ slug: 'compact-note-truth', stampMs: NOW - 7_200_000 }, NOW),
    'Resume compact-note-truth (2 hours ago)');
  // PreCompact skeletons carry no slug.
  assert.equal(
    optionLabel({ slug: '', sid: '49c3934f-1bbd-40cd', stampMs: NOW - 60_000 }, NOW),
    'Resume session 49c3934f (1 minute ago)');
});

// Read the template fresh from disk so the test exercises the actual shipped
// copy, not a duplicated inline string (single source of truth).
function loadTemplate() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.join(here, '..', 'templates', 'resume-offer.md'), 'utf8');
}

test('renderResumeOffer: no candidates → find-instructions only, and nothing to ask about', () => {
  const out = renderResumeOffer({
    template: loadTemplate(),
    dir: '/home/u/.claude/projects/C--foo',
    candidates: [],
    now: NOW,
  });
  assert.match(out, /STATE handoffs for this directory live in/);
  assert.match(out, /\/home\/u\/\.claude\/projects\/C--foo/);
  assert.match(out, /newest `STATE\*\.md`/);
  assert.match(out, /plain `STATE\.md`/);
  // Nothing to choose between — the hook must not tell the agent to ask.
  assert.doesNotMatch(out, /AskUserQuestion/);
  assert.doesNotMatch(out, /Start fresh/);
});

test('renderResumeOffer: candidates → one labelled row each, plus the instruction to ask', () => {
  const out = renderResumeOffer({
    template: loadTemplate(),
    dir: '/home/u/.claude/projects/C--foo',
    candidates: [
      { slug: 'note-truth', sid: 'aaa', stampMs: NOW - 120_000, path: '/p/STATE_a.md', summary: 'first thing' },
      { slug: 'voice', sid: 'bbb', stampMs: NOW - 7_200_000, path: '/p/STATE_b.md', summary: 'second thing' },
    ],
    now: NOW,
  });
  assert.match(out, /AskUserQuestion/);
  assert.match(out, /"Start fresh" option/);
  assert.match(out, /- Resume note-truth \(2 minutes ago\) — `\/p\/STATE_a\.md` — first thing/);
  assert.match(out, /- Resume voice \(2 hours ago\) — `\/p\/STATE_b\.md` — second thing/);
  // The find-instructions survive — the shortlist is additive.
  assert.match(out, /newest `STATE\*\.md`/);
});

test('renderResumeOffer: a rambling session line is capped, not pasted whole', () => {
  const long = 'x'.repeat(400) + ' tail';
  const out = renderResumeOffer({
    template: loadTemplate(),
    dir: '/d',
    candidates: [{ slug: 's', sid: 'i', stampMs: NOW, path: '/p/STATE_a.md', summary: long }],
    now: NOW,
  });
  assert.ok(!out.includes(long), 'the full summary must not be pasted');
  assert.match(out, /…/);
  // Newlines in a summary would break the one-row-per-candidate shape.
  assert.equal(out.split('- Resume').length, 2);
});

test('renderResumeOffer: empty dir is tolerated (no throw, blank where dir should be)', () => {
  const out = renderResumeOffer({ template: loadTemplate(), dir: '', candidates: [] });
  assert.match(out, /STATE handoffs for this directory live in ``\./);
});
