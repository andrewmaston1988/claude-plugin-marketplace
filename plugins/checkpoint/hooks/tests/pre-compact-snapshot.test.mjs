import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSkeleton } from '../pre-compact-snapshot.mjs';

test('skeleton carries the marker the checkpoint skill detects', () => {
  const body = buildSkeleton([], 'auto', 'sid123456789', '/tmp/proj', 1234);
  assert.match(body, /Skeletal backstop written by `pre-compact-snapshot\.mjs`/);
  assert.match(body, /## Session/);
});

test('skeleton extracts last user/assistant text', () => {
  const entries = [
    { message: { role: 'user', content: 'do the thing' } },
    { message: { role: 'assistant', content: [{ type: 'text', text: 'done the thing' }] } },
  ];
  const body = buildSkeleton(entries, 'manual', 'sid', '/tmp', 10);
  assert.match(body, /do the thing/);
  assert.match(body, /done the thing/);
});

// ---- end-to-end: content guard prevents self-clobber ----

const HOOK = new URL('../pre-compact-snapshot.mjs', import.meta.url);
const HOOK_PATH = HOOK.pathname.startsWith('/') && /^[A-Za-z]:/.test(HOOK.pathname.slice(1))
  ? HOOK.pathname.slice(1)  // strip leading '/' on Windows so node can resolve it
  : HOOK.pathname;

function runHookWithPayload(cwd, sid) {
  const payload = JSON.stringify({
    cwd, session_id: sid, trigger: 'auto', transcript_path: '',
  });
  return spawnSync(process.execPath, [HOOK_PATH], {
    input: payload, encoding: 'utf8', env: { ...process.env },
  });
}

test('snapshot writes a new per-session STATE_<sid>_<stamp>.md when none exists', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-hook-'));
  const sid = `t-${Date.now()}-A`;
  const r = runHookWithPayload(cwd, sid);
  assert.equal(r.status, 0, `hook failed: ${r.stderr}`);
  const dir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[\\/:]/g, '-'));
  const files = fs.readdirSync(dir).filter(n => n.startsWith(`STATE_${sid}_`));
  assert.equal(files.length, 1, 'exactly one per-session file');
  assert.match(files[0], /\.md$/);
  const body = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  assert.match(body, /Skeletal backstop/);
});

test('snapshot does NOT clobber a non-empty per-session STATE (content guard)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-hook-'));
  const sid = `t-${Date.now()}-B`;
  const dir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[\\/:]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = '20260624T064645Z';
  const ownFile = path.join(dir, `STATE_${sid}_${stamp}.md`);
  const rich = '# rich STATE\n\nOBJECTIVE: do the real work\n\n## CURRENT STATE\nin progress';
  fs.writeFileSync(ownFile, rich, 'utf8');

  const r = runHookWithPayload(cwd, sid);
  assert.equal(r.status, 0);
  const after = fs.readFileSync(ownFile, 'utf8');
  assert.equal(after, rich, 'content must be unchanged after snapshot');
});

test('snapshot does NOT touch another sessionId\'s per-session file', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-hook-'));
  const dir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[\\/:]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const otherSid = 'someone-elses-session';
  const stamp = '20260624T064645Z';
  const otherFile = path.join(dir, `STATE_${otherSid}_${stamp}.md`);
  const rich = '# someone else\'s rich STATE — must survive';
  fs.writeFileSync(otherFile, rich, 'utf8');

  const r = runHookWithPayload(cwd, 'my-session');
  assert.equal(r.status, 0);
  const after = fs.readFileSync(otherFile, 'utf8');
  assert.equal(after, rich, 'other session file must be untouched');
});

test('snapshot: existing per-session file has empty content → it gets overwritten with the skeleton', () => {
  // The original bug was an external (not per-session) clobber. With per-session
  // isolation, that's impossible. But a per-session file that is empty should
  // still be writable — the content guard is "non-empty", not "exists".
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-hook-'));
  const sid = `t-${Date.now()}-C`;
  const dir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[\\/:]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = '20260624T064645Z';
  const ownFile = path.join(dir, `STATE_${sid}_${stamp}.md`);
  fs.writeFileSync(ownFile, '   \n\n  \t  \n', 'utf8'); // whitespace only

  const r = runHookWithPayload(cwd, sid);
  assert.equal(r.status, 0);
  const after = fs.readFileSync(ownFile, 'utf8');
  assert.match(after, /Skeletal backstop/, 'empty/blank file is fair game to overwrite');
});
