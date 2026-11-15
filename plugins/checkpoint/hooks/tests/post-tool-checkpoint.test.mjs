import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { GROWTH_THROTTLE_BYTES } from '../post-tool-checkpoint.mjs';
import { checkpointNudge, nudgeStatePath, readNudgeState } from '../lib/nudge.mjs';

const OPUS = 'claude-opus-5-5';
const OPERATOR = { autoCompactWindow: 400_000, modelSettings: { [OPUS]: { autoCompactWindow: 500_000 } } };

const HOOK = new URL('../post-tool-checkpoint.mjs', import.meta.url);
const HOOK_PATH = HOOK.pathname.startsWith('/') && /^[A-Za-z]:/.test(HOOK.pathname.slice(1))
  ? HOOK.pathname.slice(1)
  : HOOK.pathname;

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

// Isolated home: nothing in this file may touch the operator's ~/.claude.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-posttool-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  write(path.join(home, '.claude', 'settings.json'), JSON.stringify(OPERATOR));
  return { root, home, cwd: path.join(root, 'repo'), nudgeDir: path.join(home, '.claude', '.checkpoint-nudge') };
}

function cleanEnv(home, extra = {}) {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  delete env.CORRELATION_ID;
  return { ...env, HOME: home, USERPROFILE: home, ...extra };
}

// A transcript whose last usage-bearing assistant turn sits at the end of the
// file, behind optional filler bytes.
function usageTranscript(file, used, fillerBytes = 0) {
  const lines = [];
  if (fillerBytes > 0) {
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(fillerBytes) } }));
  }
  lines.push(JSON.stringify({
    message: { role: 'assistant', model: OPUS, usage: { input_tokens: used, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }));
  write(file, lines.join('\n') + '\n');
  return fs.statSync(file).size;
}

function runHook(home, payload, extraEnv) {
  return spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(payload), encoding: 'utf8', env: cleanEnv(home, extraEnv),
  });
}

function runHookAsync(home, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK_PATH], { env: cleanEnv(home) });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('exit', status => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const nudgesIn = (stdout) => stdout.split('\n').filter(l => {
  try { return Boolean(JSON.parse(l).hookSpecificOutput.additionalContext); } catch { return false; }
});

test('the growth throttle is 64 KiB', () => {
  assert.equal(GROWTH_THROTTLE_BYTES, 64 * 1024);
});

// ---- (a) emits the nudge as PostToolUse additionalContext ----

test('PostToolUse emits the band nudge as additionalContext', (t) => {
  const f = fixture(t);
  const transcript = path.join(f.root, 'session.jsonl');
  usageTranscript(transcript, 407_000, 100_000);

  const r = runHook(f.home, { cwd: f.cwd, session_id: 'pt-a', transcript_path: transcript });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /Compaction in ~60k tokens/);
});

// ---- (b) below the throttle the tail is never read ----

test('PostToolUse skips the decision when the transcript grew under 64 KiB', (t) => {
  const f = fixture(t);
  const transcript = path.join(f.root, 'session.jsonl');
  usageTranscript(transcript, 100_000, 100_000); // below `soon`: silent, records the size
  const first = runHook(f.home, { cwd: f.cwd, session_id: 'pt-b', transcript_path: transcript });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim(), '');
  const recorded = readNudgeState(nudgeStatePath('pt-b', f.nudgeDir)).lastSize;
  assert.ok(recorded > 64 * 1024, 'the first decision records the transcript size');

  // The next transcript would nudge if read, but it grew by only ~20 KiB.
  usageTranscript(transcript, 407_000, 120_000);
  const throttled = runHook(f.home, { cwd: f.cwd, session_id: 'pt-b', transcript_path: transcript });
  assert.equal(throttled.status, 0, throttled.stderr);
  assert.equal(throttled.stdout.trim(), '', 'no tail read, no nudge');

  // Past 64 KiB of growth the same content fires.
  usageTranscript(transcript, 407_000, 200_000);
  const fired = runHook(f.home, { cwd: f.cwd, session_id: 'pt-b', transcript_path: transcript });
  assert.equal(fired.status, 0, fired.stderr);
  assert.match(JSON.parse(fired.stdout).hookSpecificOutput.additionalContext, /Compaction in ~60k tokens/);
});

// ---- (c) STATE_DB is never touched ----

test('PostToolUse never reads or writes STATE_DB', (t) => {
  const f = fixture(t);
  const db = path.join(f.home, '.claude', '.checkpoint-state.json');
  write(db, '{"someone":{"lastSize":3}}\n');
  const before = { body: fs.readFileSync(db, 'utf8'), stat: fs.statSync(db) };

  const transcript = path.join(f.root, 'session.jsonl');
  usageTranscript(transcript, 407_000, 100_000);
  const r = runHook(f.home, { cwd: f.cwd, session_id: 'pt-c', transcript_path: transcript });

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /additionalContext/, 'the hook did real work');
  assert.equal(fs.readFileSync(db, 'utf8'), before.body);
  assert.equal(fs.statSync(db).mtimeMs, before.stat.mtimeMs);
});

// ---- (d) eight concurrent hook processes, one nudge ----

test('eight concurrent hook processes at a band produce exactly one nudge', async (t) => {
  const f = fixture(t);
  const transcript = path.join(f.root, 'session.jsonl');
  usageTranscript(transcript, 407_000, 100_000);
  // A directory where the state file would be: every process reads empty state
  // and writes nothing, so the exclusive claim is the only thing deduping.
  fs.mkdirSync(nudgeStatePath('pt-d', f.nudgeDir), { recursive: true });
  const payload = { cwd: f.cwd, session_id: 'pt-d', transcript_path: transcript };

  const results = await Promise.all(Array.from({ length: 8 }, () => runHookAsync(f.home, payload)));
  for (const r of results) assert.equal(r.status, 0, r.stderr);
  assert.equal(results.flatMap(r => nudgesIn(r.stdout)).length, 1);
});

// ---- (e) a band claimed by UserPromptSubmit is not repeated ----

test('a band already claimed by UserPromptSubmit is not repeated by PostToolUse', (t) => {
  const f = fixture(t);
  const transcript = path.join(f.root, 'session.jsonl');
  const size = usageTranscript(transcript, 407_000, 100_000);

  const promptNudge = checkpointNudge({
    recentTurns: [{ model: OPUS, usage: { input_tokens: 407_000 } }],
    cwd: f.cwd, env: {}, sessionId: 'pt-e', settings: {}, home: f.home, nudgeDir: f.nudgeDir,
  });
  assert.match(promptNudge, /Compaction/);

  const r = runHook(f.home, { cwd: f.cwd, session_id: 'pt-e', transcript_path: transcript });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
  // The decision did run (it recorded the size); only the band was claimed.
  assert.equal(readNudgeState(nudgeStatePath('pt-e', f.nudgeDir)).lastSize, size);
});

// ---- (f) silent with CORRELATION_ID ----

test('PostToolUse is silent when CORRELATION_ID is set', (t) => {
  const f = fixture(t);
  const transcript = path.join(f.root, 'session.jsonl');
  usageTranscript(transcript, 407_000, 100_000);
  const r = runHook(f.home, { cwd: f.cwd, session_id: 'pt-f', transcript_path: transcript }, { CORRELATION_ID: 'leaf-1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
  assert.equal(fs.existsSync(nudgeStatePath('pt-f', f.nudgeDir)), false, 'nothing written at all');
});

test('PostToolUse is silent without a transcript or session id', (t) => {
  const f = fixture(t);
  const missing = runHook(f.home, { cwd: f.cwd, session_id: 'pt-g', transcript_path: '' });
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout.trim(), '');
  const noSid = runHook(f.home, { cwd: f.cwd, session_id: '', transcript_path: path.join(f.root, 'nope.jsonl') });
  assert.equal(noSid.status, 0);
  assert.equal(noSid.stdout.trim(), '');
});

// ---- (g) eight concurrent writeJSON writers leave valid JSON ----

test('writeJSON from eight concurrent writers never leaves invalid JSON', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-writejson-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'db.json');
  const moduleUrl = new URL('../lib/paths.mjs', import.meta.url).href;

  const children = [];
  for (let i = 0; i < 8; i++) {
    const code = [
      `import { writeJSON } from ${JSON.stringify(moduleUrl)};`,
      `const target = ${JSON.stringify(target)};`,
      `const pad = 'x'.repeat(${24_000 + i * 4_000});`,
      'const until = Date.now() + 900;',
      `for (let n = 0; Date.now() < until; n++) writeJSON(target, { id: ${i}, n, pad });`,
    ].join('\n');
    children.push(spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] }));
  }

  const invalid = [];
  const codes = [];
  let running = children.length;
  for (const c of children) {
    c.on('exit', code => {
      codes.push(code);
      running -= 1;
    });
  }
  while (running > 0) {
    try {
      JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') invalid.push(e.message);
    }
    await delay(10);
  }

  assert.deepEqual(codes, [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(invalid, [], 'a concurrent reader must never see a torn file');
  const final = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.ok([0, 1, 2, 3, 4, 5, 6, 7].includes(final.id));
  assert.ok(final.pad.length >= 24_000);
});
