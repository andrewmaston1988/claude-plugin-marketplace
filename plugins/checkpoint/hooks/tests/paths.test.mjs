import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sanitizeSid, nowStamp, sessionStateFilename,
  resolveOwnStatePath, resolveLatestStatePath,
  isMeaningfulState, resolveStatePath, projectDir,
} from '../lib/paths.mjs';

// ---- pure helpers ----

test('sanitizeSid: keeps uuid-like and dashed ids, drops everything else', () => {
  assert.equal(sanitizeSid('abc12345-1234-1234-1234-123456789012'),
    'abc12345-1234-1234-1234-123456789012');
  assert.equal(sanitizeSid('sid/with:bad*chars'), 'sidwithbadchars');
  assert.equal(sanitizeSid(''), '');
  assert.equal(sanitizeSid(undefined), '');
});

test('nowStamp: produces a sortable UTC stamp of the expected shape', () => {
  const stamp = nowStamp(new Date('2026-06-24T06:46:45.000Z'));
  assert.equal(stamp, '20260624T064645Z');
  // Two stamps one second apart must sort lexicographically
  const a = nowStamp(new Date('2026-06-24T06:46:45.000Z'));
  const b = nowStamp(new Date('2026-06-24T06:46:46.000Z'));
  assert.ok(a < b, 'later stamp sorts greater');
});

test('sessionStateFilename: composes the canonical pattern', () => {
  const fn = sessionStateFilename('sid123', '20260624T064645Z');
  assert.equal(fn, 'STATE_sid123_20260624T064645Z.md');
  assert.equal(sessionStateFilename('', 'X'), '');
});

// ---- filesystem-backed helpers ----

function tmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cps-test-'));
}

test('resolveOwnStatePath: mints a new per-session file when none exists', () => {
  const cwd = tmpCwd();
  const p = resolveOwnStatePath(cwd, 'sid-aaaa', { now: new Date('2026-06-24T06:46:45Z') });
  assert.match(p, /STATE_sid-aaaa_20260624T064645Z\.md$/);
  // Doesn't exist on disk yet — but path is well-formed
  assert.equal(fs.existsSync(p), false);
});

test('resolveOwnStatePath: returns the same file (preserves original stamp) on re-call', () => {
  const cwd = tmpCwd();
  const dir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[\\/:]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const original = path.join(dir, 'STATE_sid-bbbb_20260620T010000Z.md');
  fs.writeFileSync(original, '# old', 'utf8');
  const p = resolveOwnStatePath(cwd, 'sid-bbbb', { now: new Date('2026-06-24T06:46:45Z') });
  assert.equal(p, original, 'must re-use the existing per-session file');
});

test('resolveOwnStatePath: empty sid → empty path (no file written)', () => {
  const cwd = tmpCwd();
  assert.equal(resolveOwnStatePath(cwd, ''), '');
  assert.equal(resolveOwnStatePath(cwd, null), '');
});

test('resolveOwnStatePath: per-session isolation — sid A and sid B get different files', () => {
  const cwd = tmpCwd();
  const a = resolveOwnStatePath(cwd, 'sid-A', { now: new Date('2026-06-24T06:46:45Z') });
  const b = resolveOwnStatePath(cwd, 'sid-B', { now: new Date('2026-06-24T06:46:45Z') });
  assert.notEqual(a, b);
  assert.match(a, /STATE_sid-A_/);
  assert.match(b, /STATE_sid-B_/);
});

test('resolveLatestStatePath: picks the lexicographically greatest STATE_* (latest UTC stamp)', () => {
  const cwd = tmpCwd();
  const dir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[\\/:]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'STATE_sid-A_20260620T010000Z.md'), '# A', 'utf8');
  fs.writeFileSync(path.join(dir, 'STATE_sid-B_20260624T064645Z.md'), '# B', 'utf8');
  fs.writeFileSync(path.join(dir, 'STATE_sid-C_20260622T120000Z.md'), '# C', 'utf8');
  // An unrelated file must be ignored
  fs.writeFileSync(path.join(dir, 'README.md'), 'noise', 'utf8');
  const latest = resolveLatestStatePath(cwd);
  assert.equal(path.basename(latest), 'STATE_sid-B_20260624T064645Z.md');
});

test('resolveLatestStatePath: returns empty string when no STATE_* exists', () => {
  const cwd = tmpCwd();
  assert.equal(resolveLatestStatePath(cwd), '');
});

// ---- content guard ----

test('isMeaningfulState: false for empty / whitespace-only', () => {
  assert.equal(isMeaningfulState(''), false);
  assert.equal(isMeaningfulState('   \n\t  '), false);
});

test('isMeaningfulState: true for any non-whitespace content', () => {
  assert.equal(isMeaningfulState('# heading'), true);
  assert.equal(isMeaningfulState('x'), true);
  assert.equal(isMeaningfulState('\n\n# state\n'), true);
});

// ---- CLAUDE_STATE_PATH override ----

test('resolveStatePath: CLAUDE_STATE_PATH wins over computed path', () => {
  const cwd = tmpCwd();
  const override = path.join(cwd, 'custom.md');
  fs.writeFileSync(override, 'x', 'utf8'); // must exist for resolveLatestStatePath to honour it
  process.env.CLAUDE_STATE_PATH = override;
  try {
    assert.equal(resolveStatePath(cwd, 'sid-x'), override);
    assert.equal(resolveLatestStatePath(cwd), override);
  } finally {
    delete process.env.CLAUDE_STATE_PATH;
  }
});

test('resolveLatestStatePath: CLAUDE_STATE_PATH returns empty when file does not exist', () => {
  const cwd = tmpCwd();
  process.env.CLAUDE_STATE_PATH = path.join(cwd, 'missing.md');
  try {
    assert.equal(resolveLatestStatePath(cwd), '');
  } finally {
    delete process.env.CLAUDE_STATE_PATH;
  }
});

// ---- projectDir (now exported for the SessionStart hook to render) ----

test('projectDir: encodes the cwd into ~/.claude/projects/<sanitized>', () => {
  const cwd = 'C:\\code\\foo';
  assert.equal(projectDir(cwd), path.join(os.homedir(), '.claude', 'projects', 'C--code-foo'));
});

test('projectDir: forward-slash cwd is encoded the same way', () => {
  const cwd = '/home/u/work';
  assert.equal(projectDir(cwd), path.join(os.homedir(), '.claude', 'projects', '-home-u-work'));
});
