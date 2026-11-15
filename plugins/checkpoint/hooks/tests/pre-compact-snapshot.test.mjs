import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSkeleton } from '../pre-compact-snapshot.mjs';
import { docsDirPath } from '../lib/paths.mjs';

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

// ---- docsDirPath unit tests ----

test('docsDirPath joins the STATE dir with the <blob>-docs sibling name', () => {
  const p = path.join('some', 'dir', 'STATE_slug_sid_20261115T120000Z.md');
  assert.equal(docsDirPath(p), path.join('some', 'dir', 'slug_sid-docs'));
  const plain = path.join('some', 'dir', 'STATE_sid_20261115T120000Z.md');
  assert.equal(docsDirPath(plain), path.join('some', 'dir', 'sid-docs'));
});

test('docsDirPath returns empty for a non-STATE path (CLAUDE_STATE_PATH override)', () => {
  assert.equal(docsDirPath(path.join('some', 'dir', 'override.md')), '');
  assert.equal(docsDirPath(''), '');
});

// ---- end-to-end: content guard prevents self-clobber ----

const HOOK = new URL('../pre-compact-snapshot.mjs', import.meta.url);
const HOOK_PATH = HOOK.pathname.startsWith('/') && /^[A-Za-z]:/.test(HOOK.pathname.slice(1))
  ? HOOK.pathname.slice(1)  // strip leading '/' on Windows so node can resolve it
  : HOOK.pathname;

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cps-home-'));
}

function cleanup(...dirs) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Hooks resolve STATE paths from os.homedir(); the spawned process gets an
// isolated HOME/USERPROFILE so the real ~/.claude is never touched.
function runHookWithPayload(cwd, sid, home, extraEnv = {}, extraPayload = {}) {
  const payload = JSON.stringify({
    cwd, session_id: sid, trigger: 'auto', transcript_path: '', ...extraPayload,
  });
  return spawnSync(process.execPath, [HOOK_PATH], {
    input: payload, encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv },
  });
}

function projectDirFor(home, cwd) {
  return path.join(home, '.claude', 'projects', cwd.replace(/[\\/:]/g, '-'));
}

test('snapshot writes a new per-session STATE_<sid>_<stamp>.md when none exists', () => {
  const home = tmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-hook-'));
  const sid = `t-${Date.now()}-A`;
  try {
    const r = runHookWithPayload(cwd, sid, home);
    assert.equal(r.status, 0, `hook failed: ${r.stderr}`);
    const dir = projectDirFor(home, cwd);
    const files = fs.readdirSync(dir).filter(n => n.startsWith(`STATE_${sid}_`));
    assert.equal(files.length, 1, 'exactly one per-session file');
    assert.match(files[0], /\.md$/);
    const body = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.match(body, /Skeletal backstop/);
  } finally {
    cleanup(home, cwd);
  }
});

test('snapshot does NOT clobber a non-empty per-session STATE (content guard)', () => {
  const home = tmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-hook-'));
  const sid = `t-${Date.now()}-B`;
  try {
    const dir = projectDirFor(home, cwd);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = '20260624T064645Z';
    const ownFile = path.join(dir, `STATE_${sid}_${stamp}.md`);
    const rich = '# rich STATE\n\nOBJECTIVE: do the real work\n\n## CURRENT STATE\nin progress';
    fs.writeFileSync(ownFile, rich, 'utf8');

    const r = runHookWithPayload(cwd, sid, home);
    assert.equal(r.status, 0);
    const after = fs.readFileSync(ownFile, 'utf8');
    assert.equal(after, rich, 'content must be unchanged after snapshot');
  } finally {
    cleanup(home, cwd);
  }
});

test('snapshot does NOT touch another sessionId\'s per-session file', () => {
  const home = tmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-hook-'));
  try {
    const dir = projectDirFor(home, cwd);
    fs.mkdirSync(dir, { recursive: true });
    const otherSid = 'someone-elses-session';
    const stamp = '20260624T064645Z';
    const otherFile = path.join(dir, `STATE_${otherSid}_${stamp}.md`);
    const rich = '# someone else\'s rich STATE — must survive';
    fs.writeFileSync(otherFile, rich, 'utf8');

    const r = runHookWithPayload(cwd, 'my-session', home);
    assert.equal(r.status, 0);
    const after = fs.readFileSync(otherFile, 'utf8');
    assert.equal(after, rich, 'other session file must be untouched');
  } finally {
    cleanup(home, cwd);
  }
});

test('snapshot: existing per-session file has empty content → it gets overwritten with the skeleton', () => {
  const home = tmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-hook-'));
  const sid = `t-${Date.now()}-C`;
  try {
    const dir = projectDirFor(home, cwd);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = '20260624T064645Z';
    const ownFile = path.join(dir, `STATE_${sid}_${stamp}.md`);
    fs.writeFileSync(ownFile, '   \n\n  \t  \n', 'utf8'); // whitespace only

    const r = runHookWithPayload(cwd, sid, home);
    assert.equal(r.status, 0);
    const after = fs.readFileSync(ownFile, 'utf8');
    assert.match(after, /Skeletal backstop/, 'empty/blank file is fair game to overwrite');
  } finally {
    cleanup(home, cwd);
  }
});

// ---- row 5: full checkpoint present ----

function seedRichState(home, cwd, sid, body) {
  const dir = projectDirFor(home, cwd);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = '20260624T064645Z';
  const statePath = path.join(dir, `STATE_${sid}_${stamp}.md`);
  const rich = body ?? `---\nsession: keep me\nsaved: 2026-11-15\nresume:  run the failing test\n---\n\n## OBJECTIVE\ndo the real work\n`;
  fs.writeFileSync(statePath, rich, 'utf8');
  return { dir, statePath, rich };
}

function transcriptFixture(dir) {
  const tp = path.join(dir, 'transcript.jsonl');
  const lines = [
    { message: { role: 'user', content: 'user-question-content' } },
    { message: { role: 'assistant', content: [
      { type: 'text', text: 'assistant-answer-content' },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/x.mjs' } },
    ] } },
  ];
  fs.writeFileSync(tp, lines.map(l => JSON.stringify(l)).join('\n'));
  return tp;
}

test('row 5a: a full checkpoint STATE is left byte-identical', () => {
  const home = tmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-hook-'));
  const sid = `t-${Date.now()}-5a`;
  try {
    const { statePath, rich } = seedRichState(home, cwd, sid);
    const tp = transcriptFixture(cwd);
    const r = runHookWithPayload(cwd, sid, home, {}, { transcript_path: tp });
    assert.equal(r.status, 0);
    assert.equal(fs.readFileSync(statePath, 'utf8'), rich, 'STATE must not be overwritten');
  } finally {
    cleanup(home, cwd);
  }
});

test('row 5b: snapshot lands in <STATE dir>/<blob>-docs, created, with transcript content', () => {
  const home = tmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-hook-'));
  const sid = `t-${Date.now()}-5b`;
  try {
    const { dir } = seedRichState(home, cwd, sid);
    const tp = transcriptFixture(cwd);
    const r = runHookWithPayload(cwd, sid, home, {}, { transcript_path: tp });
    assert.equal(r.status, 0);
    const docsDir = path.join(dir, `${sid}-docs`);
    const snaps = fs.readdirSync(docsDir).filter(n => /^precompact-\d{8}T\d{6}Z\.md$/.test(n));
    assert.equal(snaps.length, 1, 'exactly one snapshot in the docs dir');
    const snap = fs.readFileSync(path.join(docsDir, snaps[0]), 'utf8');
    assert.match(snap, /user-question-content/);
    assert.match(snap, /assistant-answer-content/);
    assert.match(snap, /Edit/);
  } finally {
    cleanup(home, cwd);
  }
});

test('row 5c: stdout leads with the read-first sentence, then the snapshot, truncating a huge resume line to 10k', () => {
  const home = tmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-hook-'));
  const sid = `t-${Date.now()}-5c`;
  try {
    const hugeResume = 'resume:  ' + 'x'.repeat(20_000);
    seedRichState(home, cwd, sid,
      `---\nsession: keep me\n${hugeResume}\n---\n\n## OBJECTIVE\ndo the real work\n`);
    const tp = transcriptFixture(cwd);
    const r = runHookWithPayload(cwd, sid, home, {}, { transcript_path: tp });
    assert.equal(r.status, 0);
    const out = r.stdout;
    const statePath = path.join(projectDirFor(home, cwd), `STATE_${sid}_20260624T064645Z.md`);
    assert.ok(out.startsWith(`After compaction, the first action is to Read \`${statePath}\` in full`),
      `stdout must lead with the read-first sentence naming the STATE path, got: ${out.slice(0, 200)}`);
    const snapMatch = out.match(/precompact-\d{8}T\d{6}Z\.md/);
    assert.ok(snapMatch, 'stdout names the snapshot');
    assert.ok(out.length <= 10_000, `stdout must stay within 10,000 chars, got ${out.length}`);
  } finally {
    cleanup(home, cwd);
  }
});

test('row 5d: CLAUDE_STATE_PATH override → no snapshot, stdout still names the STATE', () => {
  const home = tmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-hook-'));
  const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-override-'));
  const override = path.join(overrideDir, 'override.md');
  fs.writeFileSync(override, '# rich\n\nOBJECTIVE: keep\n', 'utf8');
  try {
    const r = runHookWithPayload(cwd, 'some-sid', home, { CLAUDE_STATE_PATH: override });
    assert.equal(r.status, 0);
    const out = r.stdout;
    assert.ok(out.includes(override), 'stdout still names the STATE path');
    assert.ok(!/precompact-\d{8}T\d{6}Z\.md/.test(out), 'no snapshot path in stdout');
    assert.ok(!fs.existsSync(path.join(overrideDir, 'override-docs')), 'no docs dir created');
    assert.equal(fs.readFileSync(override, 'utf8'), '# rich\n\nOBJECTIVE: keep\n', 'override file untouched');
  } finally {
    cleanup(home, cwd, overrideDir);
  }
});

// ---- row 6: no full checkpoint ----

test('row 6a: no STATE → skeleton written as today, stdout names it, exit 0', () => {
  const home = tmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-hook-'));
  const sid = `t-${Date.now()}-6a`;
  try {
    const r = runHookWithPayload(cwd, sid, home);
    assert.equal(r.status, 0);
    const dir = projectDirFor(home, cwd);
    const files = fs.readdirSync(dir).filter(n => n.startsWith(`STATE_${sid}_`));
    assert.equal(files.length, 1);
    const statePath = path.join(dir, files[0]);
    assert.match(fs.readFileSync(statePath, 'utf8'), /Skeletal backstop/);
    assert.ok(r.stdout.includes(statePath), 'stdout names the STATE path');
  } finally {
    cleanup(home, cwd);
  }
});

test('row 6b: no session id → no write, exit 0', () => {
  const home = tmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-hook-'));
  try {
    const payload = JSON.stringify({ cwd, trigger: 'auto', transcript_path: '' });
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      input: payload, encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(r.status, 0);
    const projDir = projectDirFor(home, cwd);
    const wrote = fs.existsSync(projDir) && fs.readdirSync(projDir).some(n => n.startsWith('STATE_'));
    assert.equal(wrote, false, 'no STATE file written without a session id');
  } finally {
    cleanup(home, cwd);
  }
});
