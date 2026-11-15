import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { isThirdPartyModel, TTL_NOTES } from '../prompt-submit-checkpoint.mjs';
import {
  checkpointNudge, buildCheckpointNudge, reserveTokens, nudgeStatePath,
  DEFAULT_COMPACT_RESERVE_TOKENS,
} from '../lib/nudge.mjs';
import { resolveTtlSource } from '../lib/cadence.mjs';
import { writeCatalog } from './helpers/catalog.mjs';

const OPUS = 'claude-opus-5-5';
const DEEPSEEK = 'deepseek-v4.1-flash:1017-cloud';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-4-5-20251001';

// The operator's own settings: 400k top level, 500k for Opus.
const OPERATOR = { autoCompactWindow: 400_000, modelSettings: { [OPUS]: { autoCompactWindow: 500_000 } } };

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

const turn = (model, used) => ({
  model, usage: { input_tokens: used, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
});

// Isolated home + nudge dir: nothing here may touch the operator's ~/.claude.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-nudge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  write(path.join(home, '.claude', 'settings.json'), JSON.stringify(OPERATOR));
  writeCatalog(home);
  return { root, home, cwd: path.join(root, 'repo'), nudgeDir: path.join(root, 'nudge') };
}

function nudgeAt(f, used, model = OPUS, extra = {}) {
  return checkpointNudge({
    recentTurns: [turn(model, used)],
    cwd: f.cwd,
    env: {},
    sessionId: 'sid-1',
    settings: {},
    home: f.home,
    nudgeDir: f.nudgeDir,
    ...extra,
  });
}

// ---- operator settings: the band lines, in tokens (row 2) ----

test('operator settings: Opus compacts at 467k, nudges at 347k and 407k', (t) => {
  const f = fixture(t);
  assert.equal(nudgeAt(f, 346_999), null);
  const soon = nudgeAt(f, 347_000);
  assert.match(soon, /~347k of ~467k/);
  assert.match(soon, /~120k left/);
  assert.match(soon, /next natural pause/i);
  const now = nudgeAt(f, 407_000);
  assert.match(now, /Compaction in ~60k tokens/);
  assert.match(now, /before your next tool call/i);
});

test('operator settings: deepseek compacts at 367k, nudges at 247k and 307k', (t) => {
  const f = fixture(t);
  assert.equal(nudgeAt(f, 246_999, DEEPSEEK), null);
  assert.match(nudgeAt(f, 247_000, DEEPSEEK), /~247k of ~367k/);
  assert.match(nudgeAt(f, 307_000, DEEPSEEK), /Compaction in ~60k tokens/);
});

test('operator settings: Sonnet 5.5 compacts at 367k, nudges at 247k and 307k', (t) => {
  const f = fixture(t);
  assert.equal(nudgeAt(f, 246_999, SONNET), null);
  assert.match(nudgeAt(f, 247_000, SONNET), /~247k of ~367k/);
  assert.match(nudgeAt(f, 307_000, SONNET), /Compaction in ~60k tokens/);
});

test('operator settings: Haiku 4.5 compacts at 167k, reserve clamped to 41,750', (t) => {
  const f = fixture(t);
  assert.equal(nudgeAt(f, 83_499, HAIKU), null);
  // 83,500 rounds to ~84k in the display.
  assert.match(nudgeAt(f, 83_500, HAIKU), /~84k of ~167k/);
  assert.match(nudgeAt(f, 125_250, HAIKU), /Compaction in ~42k tokens/);
});

// ---- one fire per band per cycle; the claim is the gate (row 3) ----

test('each band fires once per cycle, and a compacted cycle re-arms it', (t) => {
  const f = fixture(t);
  assert.match(nudgeAt(f, 407_000), /Compaction/);
  assert.equal(nudgeAt(f, 410_000), null); // same cycle, band already fired
  assert.equal(nudgeAt(f, 100_000), null); // dropped below soon: new cycle
  assert.match(nudgeAt(f, 347_000), /~347k of ~467k/);
  assert.match(nudgeAt(f, 407_000), /Compaction/);
});

test('an existing claim blocks the band even when the state file is lost', (t) => {
  const f = fixture(t);
  assert.match(nudgeAt(f, 407_000), /Compaction/);
  fs.rmSync(nudgeStatePath('sid-1', f.nudgeDir));
  assert.equal(nudgeAt(f, 407_000), null);
});

test('a custom reserve moves both lines', (t) => {
  const f = fixture(t);
  const custom = { checkpoint: { compactReserveTokens: 30_000 } };
  assert.equal(nudgeAt(f, 406_999, OPUS, { settings: custom }), null);
  assert.match(nudgeAt(f, 407_000, OPUS, { settings: custom }), /~407k of ~467k/);
  assert.equal(nudgeAt(f, 436_999, OPUS, { settings: custom }), null);
  assert.match(nudgeAt(f, 437_000, OPUS, { settings: custom }), /Compaction in ~30k/);
});

test('reserveTokens: default 60k, custom wins, junk falls back', () => {
  assert.equal(DEFAULT_COMPACT_RESERVE_TOKENS, 60_000);
  assert.equal(reserveTokens({}), 60_000);
  assert.equal(reserveTokens({ checkpoint: { compactReserveTokens: 45_000 } }), 45_000);
  assert.equal(reserveTokens({ checkpoint: { compactReserveTokens: 'x' } }), 60_000);
  assert.equal(reserveTokens({ checkpoint: { compactReserveTokens: -1 } }), 60_000);
});

test('buildCheckpointNudge names the qualified skill and never inlines the template', () => {
  for (const note of [buildCheckpointNudge('soon', 350_000, 467_000), buildCheckpointNudge('now', 410_000, 467_000)]) {
    assert.match(note, /skill="checkpoint:checkpoint"/);
    assert.match(note, /not the built-in checkpoint\/rewind/i);
    assert.match(note, /handover/i);
    assert.doesNotMatch(note, /## 1\. OBJECTIVE/);
  }
});

test('the byte fallback is measured in tokens, ~4 bytes per token', (t) => {
  const f = fixture(t);
  // No usage row: 988,000 bytes -> 247,000 tokens, the deepseek-free top-level
  // 400k window's soon line (T 367k, r 60k).
  const soon = checkpointNudge({
    recentTurns: [], cwd: f.cwd, env: {}, sessionId: 'bytes-1', settings: {},
    home: f.home, nudgeDir: f.nudgeDir, fallbackUsed: 247_000,
  });
  assert.match(soon, /~247k of ~367k/);
  const quiet = checkpointNudge({
    recentTurns: [], cwd: f.cwd, env: {}, sessionId: 'bytes-2', settings: {},
    home: f.home, nudgeDir: f.nudgeDir, fallbackUsed: 246_999,
  });
  assert.equal(quiet, null);
});

// ---- the hook itself ----

const HOOK = new URL('../prompt-submit-checkpoint.mjs', import.meta.url);
const HOOK_PATH = HOOK.pathname.startsWith('/') && /^[A-Za-z]:/.test(HOOK.pathname.slice(1))
  ? HOOK.pathname.slice(1)
  : HOOK.pathname;

function spawnHook(home, payload) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CORRELATION_ID;
  delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  return spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(payload), encoding: 'utf8', env,
  });
}

function usageTranscript(file, model, used) {
  write(file, JSON.stringify({
    message: { role: 'assistant', model, usage: { input_tokens: used, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }) + '\n');
}

function sizedTranscript(file, bytes) {
  const prefix = JSON.stringify({ type: 'user', message: { role: 'user', content: '' } }) + '\n';
  write(file, prefix + 'x'.repeat(bytes - prefix.length - 1) + '\n');
  assert.equal(fs.statSync(file).size, bytes);
}

test('the hook emits the band nudge as UserPromptSubmit additionalContext', (t) => {
  const f = fixture(t);
  const transcript = path.join(f.root, 'session.jsonl');
  usageTranscript(transcript, OPUS, 407_000);

  const r = spawnHook(f.home, {
    cwd: f.cwd, session_id: 'hook-1', prompt: 'carry on', transcript_path: transcript,
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /Compaction in ~60k tokens/);
});

test('the hook no longer writes lastFiredPct to STATE_DB', (t) => {
  const f = fixture(t);
  const transcript = path.join(f.root, 'session.jsonl');
  usageTranscript(transcript, OPUS, 407_000);

  const r = spawnHook(f.home, {
    cwd: f.cwd, session_id: 'hook-2', prompt: 'carry on', transcript_path: transcript,
  });
  assert.equal(r.status, 0, r.stderr);
  const db = fs.readFileSync(path.join(f.home, '.claude', '.checkpoint-state.json'), 'utf8');
  assert.ok(db.includes('hook-2'), 'the session row is still written');
  assert.doesNotMatch(db, /lastFiredPct/);
});

test('the hook nudges on a byte-only transcript at the 4-bytes-per-token line', (t) => {
  const f = fixture(t);
  const atLine = path.join(f.root, 'at-line.jsonl');
  sizedTranscript(atLine, 988_000);
  const r = spawnHook(f.home, {
    cwd: f.cwd, session_id: 'hook-3', prompt: 'go', transcript_path: atLine,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /~247k of ~367k/);

  const justBelow = path.join(f.root, 'just-below.jsonl');
  sizedTranscript(justBelow, 987_996);
  const quiet = spawnHook(f.home, {
    cwd: f.cwd, session_id: 'hook-4', prompt: 'go', transcript_path: justBelow,
  });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout.trim(), '');
});

// ---- keepalive helpers (unchanged behaviour) ----

test('keepalive-init template does not hand the model an excuse to skip', () => {
  const tmpl = fs.readFileSync(new URL('../templates/keepalive-init.md', import.meta.url), 'utf8');
  assert.doesNotMatch(tmpl, /\*\*Skip this\*\*/i);
  assert.match(tmpl, /even if you are mid-task/i);
});

// The 2026-07-16 refusal, part 1: a defaulted TTL presented as "detected" reads
// as stale detection and gets the whole injection distrusted.
test('keepalive-init template states TTL provenance via {ttlNote}, never a hardcoded claim', () => {
  const tmpl = fs.readFileSync(new URL('../templates/keepalive-init.md', import.meta.url), 'utf8');
  assert.match(tmpl, /\{ttlNote\}/);
  assert.doesNotMatch(tmpl, /TTL \(detected from the cache-bucket usage/);
});

// The 2026-07-16 refusal, part 2: the Fable 5 ScheduleWakeup contract forbids
// cache-warming wakeups; without an explicit answer, compliant models decline.
test('keepalive-init template answers the ScheduleWakeup no-cache-warming contract', () => {
  const tmpl = fs.readFileSync(new URL('../templates/keepalive-init.md', import.meta.url), 'utf8');
  assert.match(tmpl, /operator-configured, opt-in/i);
  assert.match(tmpl, /past/i); // the chain extends the cache PAST its TTL — the case the contract ignores
  assert.match(tmpl, /operator-opted-in cache keepalive/); // reason string says what it really is
});

// The 2026-08-31 stall: ScheduleWakeup's RESULT text ("Nothing more to do this
// turn — the harness re-invokes you…") lands after the injection prose and
// reads as a stop order, so a session that scheduled the tick as a lone call
// abandoned its mid-flight task. The template must (a) instruct batching the
// tick with the next real tool call and (b) pre-empt the result line by name.
// RED input: a template missing either instruction — the exact pre-fix text.
test('keepalive-init template defuses the ScheduleWakeup result stop-order', () => {
  const tmpl = fs.readFileSync(new URL('../templates/keepalive-init.md', import.meta.url), 'utf8');
  assert.match(tmpl, /same assistant message as your next real tool call/i);
  assert.match(tmpl, /not a stop order/i);
  assert.match(tmpl, /Nothing more to do this turn/); // pre-empts the exact line
});

// ScheduleWakeup rejects any call that omits `noop` unless `stop` is true, and
// the template says "these exact arguments" — so an arg list missing it buys a
// rejected call on every tick. RED input: the three-bullet pre-fix list.
test('keepalive-init template lists every required ScheduleWakeup argument', () => {
  const tmpl = fs.readFileSync(new URL('../templates/keepalive-init.md', import.meta.url), 'utf8');
  for (const arg of ['delaySeconds', 'prompt', 'reason', 'noop']) {
    assert.match(tmpl, new RegExp('^- `' + arg + '`', 'm'), `arg list must name ${arg}`);
  }
});

// Third-party providers expose no prompt-cache TTL — nothing to keep warm, so
// the keepalive is Claude-model-only.
test('isThirdPartyModel: non-Claude model on the newest turn skips keepalive', () => {
  assert.equal(isThirdPartyModel([{ model: 'glm-5.2:cloud' }]), true);
  assert.equal(isThirdPartyModel([{ model: 'kimi-k2.7-code:cloud' }]), true);
  // Newest turn wins, oldest-first input order.
  assert.equal(isThirdPartyModel([{ model: 'claude-opus-5' }, { model: 'glm-5.2:cloud' }]), true);
  assert.equal(isThirdPartyModel([{ model: 'glm-5.2:cloud' }, { model: 'claude-opus-5' }]), false);
});

test('isThirdPartyModel: claude family ids are never third-party', () => {
  // Bedrock/Vertex ids wrap the family name rather than starting with it.
  for (const m of ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001',
                   'us.anthropic.claude-opus-4-5-v1:0']) {
    assert.equal(isThirdPartyModel([{ model: m }]), false, m);
  }
});

test('isThirdPartyModel: unknown model fails open as Claude', () => {
  assert.equal(isThirdPartyModel([]), false);
  assert.equal(isThirdPartyModel([{ model: '<synthetic>' }]), false);
  assert.equal(isThirdPartyModel([{ usage: {} }]), false);
});

test('every resolveTtlSource source has a TTL_NOTES entry', () => {
  const h1 = [{ cache_creation: { ephemeral_1h_input_tokens: 412, ephemeral_5m_input_tokens: 0 } }];
  const cases = [[1800, [], null], [null, h1, null], [null, [], 3600], [null, [{}], null]];
  for (const [forced, usages, last] of cases) {
    const { source } = resolveTtlSource(forced, usages, last);
    assert.ok(TTL_NOTES[source], `missing TTL_NOTES entry for source "${source}"`);
  }
});
