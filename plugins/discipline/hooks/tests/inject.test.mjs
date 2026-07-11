// Fixture tests for inject.mjs:
// inject on sonnet-5 / opus-4-8, skip fable / sonnet-4-5 / opus-4-7 (family
// collision), kill switch, keepalive prompt, missing transcript, garbage stdin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'inject.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'discipline-test-'));

function transcript(model) {
  const p = path.join(tmp, `t_${model}.jsonl`);
  fs.writeFileSync(p, [
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { model, content: [] } }),
    '',
  ].join('\n'));
  return p;
}

function run(payload, envExtra = {}) {
  const env = { ...process.env, ...envExtra };
  delete env.CLAUDE_DISCIPLINE;
  Object.assign(env, envExtra);
  try {
    const out = execFileSync(process.execPath, [HOOK], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      env,
      encoding: 'utf-8',
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: String(err.stdout || '') };
  }
}

test('sonnet-5 -> pack injected', () => {
  const { code, out } = run({ prompt: 'fix the bug', transcript_path: transcript('claude-sonnet-5') });
  assert.equal(code, 0);
  assert.match(out, /<discipline-pack model="claude-sonnet-5" v="1">/);
  assert.match(out, /Verify before claiming/);
});

test('opus-4-8 -> pack injected', () => {
  const { code, out } = run({ prompt: 'fix the bug', transcript_path: transcript('claude-opus-4-8') });
  assert.equal(code, 0);
  assert.match(out, /<discipline-pack model="claude-opus-4-8" v="1">/);
  assert.match(out, /Proof means the live layer/);
});

test('opus-4-7 -> empty (no family collision)', () => {
  const { code, out } = run({ prompt: 'fix the bug', transcript_path: transcript('claude-opus-4-7') });
  assert.equal(code, 0);
  assert.equal(out.trim(), '');
});

test('fable -> empty', () => {
  const { code, out } = run({ prompt: 'fix the bug', transcript_path: transcript('claude-fable-5') });
  assert.equal(code, 0);
  assert.equal(out.trim(), '');
});

test('sonnet-4-5 -> empty (no family collision)', () => {
  const { code, out } = run({ prompt: 'fix the bug', transcript_path: transcript('claude-sonnet-4-5') });
  assert.equal(code, 0);
  assert.equal(out.trim(), '');
});

test('kill switch -> empty', () => {
  const { code, out } = run(
    { prompt: 'fix the bug', transcript_path: transcript('claude-sonnet-5') },
    { CLAUDE_DISCIPLINE: 'off' },
  );
  assert.equal(code, 0);
  assert.equal(out.trim(), '');
});

test('keepalive prompt -> empty', () => {
  const { code, out } = run({ prompt: 'Cache keepalive tick', transcript_path: transcript('claude-sonnet-5') });
  assert.equal(code, 0);
  assert.equal(out.trim(), '');
});

test('missing transcript -> exit 0, no crash', () => {
  const { code } = run({ prompt: 'hello', transcript_path: path.join(tmp, 'missing.jsonl') });
  assert.equal(code, 0);
});

test('no transcript_path -> exit 0', () => {
  const { code } = run({ prompt: 'hello' });
  assert.equal(code, 0);
});

test('garbage stdin -> exit 0 silent', () => {
  const { code, out } = run('not json{{');
  assert.equal(code, 0);
  assert.equal(out.trim(), '');
});
