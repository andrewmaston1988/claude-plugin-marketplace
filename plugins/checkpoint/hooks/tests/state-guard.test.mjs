import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  GATE_MAX_AGE_MS, actedPath, armGate, clearPreImage, gatePath, isAllowedTool,
  onPostToolUse, onPreToolUse, readLogPath, readPreImage, stateKey,
} from '../lib/state-guard.mjs';
import { liveSectionsHash } from '../lib/state-lint.mjs';
import { encodeProject } from '../lib/paths.mjs';

const HOOK = fileURLToPath(new URL('../state-guard.mjs', import.meta.url));
const HOOKS_JSON = fileURLToPath(new URL('../hooks.json', import.meta.url));
const NOW = Date.parse('2026-11-18T01:50:00Z');
const STATE_NAME = 'STATE_a_20261118T010000Z.md';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function opts(dir, extra = {}) {
  return { _dir: dir, _env: {}, _now: () => NOW, _platform: process.platform, ...extra };
}

function stateBody(lines) {
  return Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n');
}

function readPayload(sid, filePath, startLine, numLines, totalLines) {
  return {
    session_id: sid,
    tool_name: 'Read',
    tool_input: { file_path: filePath },
    tool_response: { file: { filePath, startLine, numLines, totalLines } },
  };
}

const bash = (sid, o, extra = {}) => onPreToolUse({ session_id: sid, tool_name: 'Bash', tool_input: {} }, { ...o, ...extra });

// ---- G1: arming scope ----

test('G1: a partial Read before the first act arms the gate; after acting it does not; a non-STATE Read is ignored', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, STATE_NAME);
  fs.writeFileSync(file, stateBody(112));
  const o = opts(dir, { _ownStatePath: file });

  onPostToolUse(readPayload('s1', file, 1, 4, 112), o);
  const gate = JSON.parse(fs.readFileSync(gatePath('s1', dir), 'utf8'));
  assert.equal(gate.armedAt, NOW);
  assert.equal(gate.total, 112);
  assert.equal(gate.path, file);
  const log = fs.readFileSync(readLogPath('s1', dir), 'utf8').trim().split('\n');
  assert.equal(log.length, 1, 'one line per Read');
  assert.deepEqual(
    { start: JSON.parse(log[0]).start, end: JSON.parse(log[0]).end },
    { start: 1, end: 4 },
  );

  // After the first acting call the session is mid-task: a later peek is not a resume.
  fs.rmSync(gatePath('s1', dir));
  fs.writeFileSync(actedPath('s1', dir), '');
  onPostToolUse(readPayload('s1', file, 1, 4, 112), o);
  assert.equal(fs.existsSync(gatePath('s1', dir)), false, 'a post-act Read must not arm');

  // A Read of something that is not a STATE file records nothing.
  const notes = path.join(dir, 'notes.md');
  fs.writeFileSync(notes, 'hello');
  const before = fs.readFileSync(readLogPath('s1', dir), 'utf8');
  onPostToolUse(readPayload('s1', notes, 1, 1, 1), o);
  assert.equal(fs.readFileSync(readLogPath('s1', dir), 'utf8'), before);
});

test('G1: the first allowed acting call writes the acted marker', (t) => {
  const dir = tmpDir(t);
  const o = opts(dir);
  assert.equal(bash('s1act', o), null);
  assert.equal(fs.existsSync(actedPath('s1act', dir)), true);
});

// ---- G2: coverage union ----

test('G2: overlapping, out-of-order Reads clear the gate', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, STATE_NAME);
  fs.writeFileSync(file, stateBody(112));
  const o = opts(dir);

  armGate('s2', file, o);
  const first = bash('s2', o);
  assert.equal(first.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(first.hookSpecificOutput.permissionDecisionReason, /offset 1\b/);

  onPostToolUse(readPayload('s2', file, 1, 4, 112), o);
  onPostToolUse(readPayload('s2', file, 61, 52, 112), o);
  assert.match(bash('s2', o).hookSpecificOutput.permissionDecisionReason, /offset 5\b/);
  onPostToolUse(readPayload('s2', file, 5, 56, 112), o);
  assert.equal(bash('s2', o), null, 'the union covers every line');

  // Out of order and overlapping: 61-112, then 5-60, then 1-4.
  armGate('s3', file, o);
  for (const [start, num] of [[61, 52], [5, 56], [1, 4]]) {
    onPostToolUse(readPayload('s3', file, start, num, 112), o);
  }
  assert.equal(bash('s3', o), null);
});

test('the gate arms only on the session own STATE, not a peer STATE it reads', (t) => {
  const dir = tmpDir(t);
  const own = path.join(dir, 'STATE_own_20261118T010000Z.md');
  const peer = path.join(dir, 'STATE_peer_20261118T010000Z.md');
  fs.writeFileSync(own, stateBody(112));
  fs.writeFileSync(peer, stateBody(112));
  const o = opts(dir, { _ownStatePath: own });

  onPostToolUse(readPayload('sc', peer, 1, 4, 112), o);
  assert.equal(fs.existsSync(gatePath('sc', dir)), false, 'a peer STATE arms nothing');

  onPostToolUse(readPayload('sc', own, 1, 4, 112), o);
  assert.equal(fs.existsSync(gatePath('sc', dir)), true, 'the own STATE arms');
});

test('a no-offset Read counts as the whole file and clears the gate', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, STATE_NAME);
  const body = stateBody(112);
  fs.writeFileSync(file, body);
  const o = opts(dir, { _ownStatePath: file });
  armGate('dr', file, o);

  onPostToolUse({
    session_id: 'dr',
    tool_name: 'Read',
    tool_input: { file_path: file },
    tool_response: { file: { filePath: file, content: body } }, // no startLine/numLines
  }, o);
  assert.equal(bash('dr', o), null, 'a full-content Read must clear the gate, never stick it');
});

test('a full Read from before the gate was armed does not satisfy it', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, STATE_NAME);
  fs.writeFileSync(file, stateBody(112));
  const o = opts(dir, { _ownStatePath: file });

  // The pre-compaction read is already in the log when the gate arms: the
  // resumed session must read the file again, not act on the summary.
  onPostToolUse(readPayload('b1', file, 1, 112, 112), o);
  assert.equal(fs.existsSync(gatePath('b1', dir)), false, 'a full read arms nothing');
  armGate('b1', file, o);

  const denied = bash('b1', o);
  assert.equal(denied?.hookSpecificOutput?.permissionDecision, 'deny', 'pre-arm coverage must not count');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /offset 1\b/);

  onPostToolUse(readPayload('b1', file, 1, 112, 112), o);
  assert.equal(bash('b1', o), null, 'a fresh full read clears it');
});

// ---- G3: allowlist vs denied tools ----

test('G3: acting tools are denied with the next offset; the allowlist passes', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, STATE_NAME);
  fs.writeFileSync(file, stateBody(112));
  const o = opts(dir);
  armGate('s3b', file, o);
  onPostToolUse(readPayload('s3b', file, 1, 4, 112), o);

  for (const tool of ['Bash', 'Edit', 'Write', 'PowerShell', 'Agent']) {
    const out = onPreToolUse({ session_id: 's3b', tool_name: tool, tool_input: {} }, o);
    assert.equal(out?.hookSpecificOutput?.permissionDecision, 'deny', `${tool} must be denied`);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /offset 5\b/);
  }
  for (const tool of ['Read', 'Grep', 'Glob', 'Skill', 'AskUserQuestion', 'TaskCreate', 'TaskUpdate', 'mcp__scout__context_pack']) {
    assert.equal(onPreToolUse({ session_id: 's3b', tool_name: tool, tool_input: {} }, o), null, `${tool} must pass`);
  }
  assert.equal(isAllowedTool('mcp__scout__set_annotations'), false);
});

// ---- G4: fail-open ----

test('G4: every fail-open case allows the call', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, STATE_NAME);
  fs.writeFileSync(file, stateBody(112));
  const o = opts(dir);

  // Missing file at deny time.
  const ghost = path.join(dir, 'STATE_ghost_20261118T010000Z.md');
  armGate('g1', ghost, o);
  assert.equal(bash('g1', o), null);

  // A file the fs cannot read.
  armGate('g2', file, o);
  const unreadable = { ...fs, readFileSync: (p, ...rest) => {
    if (String(p) === file) throw new Error('EACCES');
    return fs.readFileSync(p, ...rest);
  } };
  assert.equal(bash('g2', o, { _fs: unreadable }), null);

  // A gate older than 30 minutes.
  armGate('g3', file, { ...o, _now: () => NOW - GATE_MAX_AGE_MS - 1 });
  assert.equal(bash('g3', o), null);

  // Headless pipeline sessions.
  armGate('g4', file, o);
  assert.equal(bash('g4', o, { _env: { CORRELATION_ID: 'leaf-1' } }), null);

  // The explicit opt-out.
  armGate('g5', file, o);
  assert.equal(bash('g5', o, { _settings: { checkpoint: { readGate: false } } }), null);

  // A payload with nothing in it.
  assert.equal(onPreToolUse({}, o), null);
});

test('G4: non-JSON stdin exits silently through the hook entry point', (t) => {
  const dir = tmpDir(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CORRELATION_ID;
  const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
});

// ---- G5: post-write lint ----

test('G5: a post-write lint failure blocks with the errors; a non-STATE write is ignored', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, STATE_NAME);
  const bad = [
    '---',
    'session: a session',
    `resume: ${'x'.repeat(401)}`,
    'saved: 2026-11-18 01:56 UTC',
    '---',
    '',
    '## OBJECTIVE',
    'do the thing',
    '',
  ].join('\n');
  fs.writeFileSync(file, bad);

  const out = onPostToolUse({ session_id: 'w1', tool_name: 'Write', tool_input: { file_path: file } }, opts(dir));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /resume: 401 characters, over the 400/);
  assert.match(out.reason, /## CURRENT STATE/);

  const notes = path.join(dir, 'notes.md');
  fs.writeFileSync(notes, bad);
  assert.equal(onPostToolUse({ session_id: 'w1', tool_name: 'Write', tool_input: { file_path: notes } }, opts(dir)), null);
});

test('G5: a clean STATE write returns no decision', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, STATE_NAME);
  const clean = [
    '---', 'session: a session', 'resume: do the thing', 'saved: 2026-11-18 01:56 UTC', '---', '',
    '## OBJECTIVE [stable]', 'o', '',
    '## CURRENT STATE [live]', 'c', '',
    '## NEXT ACTIONS [live]', '1. do the thing', '',
    '## CONSTRAINTS & DECISIONS [stable]', 'k', '',
    '## ENV & COMMANDS [stable]', 'e', '',
    '## KEY FILES [live]', '- f', '',
    '## OUT OF SCOPE [stable]', 'x', '',
  ].join('\n');
  fs.writeFileSync(file, clean);
  assert.equal(onPostToolUse({ session_id: 'w2', tool_name: 'Edit', tool_input: { file_path: file } }, opts(dir)), null);
});

// ---- G6: append-only coverage ----

test('G6: coverage appends survive separate calls and interleaved ranges clear the gate', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, STATE_NAME);
  fs.writeFileSync(file, stateBody(112));
  const o = opts(dir);
  armGate('s6', file, o);
  for (const [start, num] of [[1, 4], [61, 52], [5, 56]]) {
    onPostToolUse(readPayload('s6', file, start, num, 112), o);
  }
  const lines = fs.readFileSync(readLogPath('s6', dir), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3, 'each Read appends its own line');
  assert.equal(bash('s6', o), null);
});

// ---- G7: MCP and SendMessage ----

test('G7: SendMessage and non-scout MCP calls are denied; the matcher routes them here', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, STATE_NAME);
  fs.writeFileSync(file, stateBody(112));
  const o = opts(dir);
  armGate('s7', file, o);

  for (const tool of ['SendMessage', 'mcp__scout__set_annotations', 'mcp__blender__execute_blender_code']) {
    assert.equal(
      onPreToolUse({ session_id: 's7', tool_name: tool, tool_input: {} }, o)?.hookSpecificOutput?.permissionDecision,
      'deny', `${tool} must be denied`,
    );
  }

  const cfg = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
  const entry = cfg.hooks.PreToolUse.find(e => e.hooks.some(h => h.command.includes('state-guard.mjs')));
  assert.ok(entry && entry.matcher, 'state-guard is registered with a matcher');
  const re = new RegExp(entry.matcher);
  for (const name of ['Bash', 'Edit', 'Write', 'PowerShell', 'Agent', 'SendMessage', 'mcp__scout__set_annotations', 'mcp__blender__execute_blender_code']) {
    assert.match(name, re, `matcher must send ${name}`);
  }
  // Every MCP name is routed here on purpose so the script can deny a
  // mutating one; the allowlist, not the matcher, passes the safe ones.
  for (const name of ['mcp__scout__context_pack', 'mcp__scout__set_annotations']) {
    assert.match(name, re, `matcher must send ${name}`);
  }
  for (const name of ['Read', 'Grep', 'Glob', 'Skill', 'AskUserQuestion', 'TaskCreate', 'TaskUpdate']) {
    assert.doesNotMatch(name, re, `matcher must not send ${name}`);
  }
});

// ---- G8: win32 path keying ----

test('G8: forward- and backslash spellings key the same coverage', (t) => {
  const dir = tmpDir(t);
  const back = 'C:\\x\\STATE_a_20261118T010000Z.md';
  const fwd = 'C:/x/STATE_a_20261118T010000Z.md';
  assert.equal(stateKey(back, 'win32'), stateKey(fwd, 'win32'));

  const body = stateBody(112);
  const _fs = { ...fs, readFileSync: (p, ...rest) => (String(p) === back ? body : fs.readFileSync(p, ...rest)) };
  const o = { _fs, _dir: dir, _env: {}, _now: () => NOW, _platform: 'win32' };
  armGate('s8', back, o);
  onPostToolUse(readPayload('s8', fwd, 1, 112, 112), o);
  assert.equal(onPreToolUse({ session_id: 's8', tool_name: 'Bash' }, o), null, 'the slash spelling cleared the gate');
});

// ---- round pre-image ----

test('the pre-image is recorded once, on the own STATE, from the inherited file', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, STATE_NAME);
  const original = stateBody(112);
  fs.writeFileSync(file, original);
  const o = opts(dir, { _ownStatePath: file });
  const write = (sid, p) => ({ session_id: sid, tool_name: 'Edit', tool_input: { file_path: p } });

  onPreToolUse(write('p1', file), o);
  assert.equal(readPreImage('p1', { _dir: dir }).hash, liveSectionsHash(original));

  // The round's first write owns it; later writes leave it alone.
  fs.writeFileSync(file, `${original}\n## CURRENT STATE\nchanged\n`);
  onPreToolUse(write('p1', file), o);
  assert.equal(readPreImage('p1', { _dir: dir }).hash, liveSectionsHash(original));

  // A coordinator's write to a peer's STATE is not its own round.
  const peer = path.join(dir, 'STATE_peer_20261118T010000Z.md');
  fs.writeFileSync(peer, original);
  onPreToolUse(write('p2', peer), opts(dir, { _ownStatePath: file }));
  assert.equal(readPreImage('p2', { _dir: dir }), null);

  assert.equal(clearPreImage('p1', { _dir: dir }), true);
  assert.equal(readPreImage('p1', { _dir: dir }), null);
});

test('the read-gate opt-out still records the round pre-image', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, STATE_NAME);
  const original = stateBody(112);
  fs.writeFileSync(file, original);
  const o = opts(dir, {
    _ownStatePath: file, _settings: { checkpoint: { readGate: false } },
  });
  onPreToolUse({ session_id: 'p4', tool_name: 'Edit', tool_input: { file_path: file } }, o);
  assert.equal(readPreImage('p4', { _dir: dir }).hash, liveSectionsHash(original),
    'the Stop must still be able to judge the round');
});

test('a mint records no pre-image: there is nothing to compare', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, STATE_NAME);
  onPreToolUse({ session_id: 'p3', tool_name: 'Write', tool_input: { file_path: file } }, opts(dir, { _ownStatePath: file }));
  assert.equal(readPreImage('p3', { _dir: dir }), null);
});

test('the entry point resolves the own STATE and records the pre-image', (t) => {
  const root = tmpDir(t);
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'repo');
  const projectDir = path.join(home, '.claude', 'projects', encodeProject(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, 'STATE_sp_20261118T010000Z.md');
  fs.writeFileSync(file, stateBody(112));

  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CORRELATION_ID;
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: 'sp', cwd, tool_name: 'Edit', tool_input: { file_path: file } }),
    encoding: 'utf8', env,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
  const rec = readPreImage('sp', { _dir: path.join(home, '.claude', '.checkpoint-nudge') });
  assert.equal(rec.hash, liveSectionsHash(stateBody(112)));
});
