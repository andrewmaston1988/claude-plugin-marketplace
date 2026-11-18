// State guard: the read gate and the round pre-image, fed by two hooks.
//
// A Read of a STATE file appends its covered line range to an append-only
// per-session log — parallel page Reads cannot clobber each other's coverage —
// and a partial Read made before the session's first acting call arms a gate on
// that file (decision 7). A Write/Edit/MultiEdit on a STATE path is linted after
// the fact and blocks the turn with the errors.
//
// PreToolUse denies an acting call while the armed file is still partly unread,
// and records the round's pre-image: the live-section hash of the file as it
// stood before this round's first write, which the Stop hook compares against.
//
// Every path fails open. A gate that bricks a session costs far more than a
// stale STATE, so anything unreadable, stale, malformed or internal allows the
// call.
//
// Stop-hook API (fs injected as `_fs`, state dir as `_dir`):
//   readPreImage(sid)  -> { hash, path, ts } | null
//   clearPreImage(sid) -> boolean
import fs from 'node:fs';
import path from 'node:path';

import {
  NUDGE_DIR, STATE_FILE_RE, docsDirPath, resolveOwnStatePath, sanitizeSid,
} from './paths.mjs';
import { lintState, liveSectionsHash } from './state-lint.mjs';

// Older than this and the gate is presumed abandoned (the compact event was
// missed, the session moved on). Never hold a session on a stale gate.
export const GATE_MAX_AGE_MS = 30 * 60 * 1000;

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const ALWAYS_ALLOWED = new Set(['Read', 'Grep', 'Glob', 'Skill', 'ToolSearch', 'AskUserQuestion']);

// --- per-session files ------------------------------------------------------

export function guardFile(sessionId, suffix, dir = NUDGE_DIR) {
  const sid = sanitizeSid(sessionId);
  return sid ? path.join(dir, `${sid}${suffix}`) : '';
}

export const readLogPath = (sid, dir) => guardFile(sid, '.read.jsonl', dir);
export const gatePath = (sid, dir) => guardFile(sid, '.gate.json', dir);
export const actedPath = (sid, dir) => guardFile(sid, '.acted', dir);
export const preImagePath = (sid, dir) => guardFile(sid, '.preimage.json', dir);

// --- path keys --------------------------------------------------------------

// `C:/x/STATE_a.md` and `C:\x\STATE_a.md` must key the same coverage: the Read
// payload reports forward slashes while tool_input carries backslashes (P0).
export function stateKey(p, platform = process.platform) {
  if (!p) return '';
  if (platform === 'win32') return path.win32.resolve(String(p)).toLowerCase();
  return path.resolve(String(p));
}

// A STATE path is a per-session STATE file, or the `CLAUDE_STATE_PATH` override
// whose basename need not follow the STATE shape.
export function isStatePath(p, { _env = process.env, _platform = process.platform } = {}) {
  if (!p) return false;
  const base = (_platform === 'win32' ? path.win32 : path).basename(String(p));
  if (STATE_FILE_RE.test(base)) return true;
  const override = _env && _env.CLAUDE_STATE_PATH;
  return !!override && stateKey(override, _platform) === stateKey(p, _platform);
}

// The allowlist (decision 6): a session can always finish reading or ask. The
// matcher never sends these, so this is the in-script backstop for a broadened
// matcher — and the exact set the deny list was rejected for missing.
export function isAllowedTool(name) {
  if (!name) return false;
  if (ALWAYS_ALLOWED.has(name)) return true;
  if (/^Task/.test(name)) return true; // TaskCreate / TaskUpdate / TaskOutput ...
  return /^mcp__scout__/.test(name) && name !== 'mcp__scout__set_annotations';
}

// --- small fs helpers -------------------------------------------------------

function readJson(_fs, p) {
  try { return JSON.parse(_fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(_fs, p, obj) {
  try {
    _fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    _fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    _fs.renameSync(tmp, p);
  } catch { /* non-fatal */ }
}

// Exclusive publish for the pre-image: the round's FIRST writer owns it. A
// hard link is the atomic create; `wx` is the fallback where links are unsupported.
function publishOnce(_fs, p, obj) {
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try { _fs.mkdirSync(path.dirname(p), { recursive: true }); } catch { /* non-fatal */ }
  try {
    _fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    _fs.linkSync(tmp, p);
    return;
  } catch { /* link unsupported, or the pre-image is already recorded */ }
  finally { try { _fs.unlinkSync(tmp); } catch { /* never written */ } }
  try {
    const fd = _fs.openSync(p, 'wx');
    try { _fs.writeSync(fd, JSON.stringify(obj)); } finally { _fs.closeSync(fd); }
  } catch { /* already recorded this round */ }
}

function removeFile(_fs, p) {
  try { _fs.unlinkSync(p); } catch { /* already gone */ }
}

function fileExists(_fs, p) {
  try { return _fs.existsSync(p); } catch { return false; }
}

// --- coverage ---------------------------------------------------------------

function appendCoverage(_fs, p, entry) {
  try {
    _fs.mkdirSync(path.dirname(p), { recursive: true });
    // O_APPEND: page Reads racing in one turn interleave lines, never overwrite.
    _fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* non-fatal */ }
}

function mergeRanges(list) {
  const sorted = [...list].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function coverageRanges(_fs, p, key, gen = null) {
  let raw = '';
  try { raw = _fs.readFileSync(p, 'utf8'); } catch { return []; }
  const ranges = [];
  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || e.path !== key) continue;
    if (gen !== null && String(e.gen || '') !== gen) continue;
    const start = Number(e.start);
    const end = Number(e.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) ranges.push([start, end]);
  }
  return mergeRanges(ranges);
}

// First uncovered line and the end of its contiguous run, or null when the
// union covers every line.
function firstGap(ranges, total) {
  let next = 1;
  for (const [s, e] of ranges) {
    if (s > next) return { a: next, b: Math.min(s - 1, total) };
    if (e >= next) next = e + 1;
    if (next > total) return null;
  }
  return next <= total ? { a: next, b: total } : null;
}

function lineCount(body) {
  const lines = String(body).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return Math.max(1, lines.length);
}

// --- PostToolUse ------------------------------------------------------------

// Returns a PostToolUse block decision for a STATE write that fails the lint,
// null otherwise. The Read and Write halves share one hook process, so the
// guard costs no extra spawn per tool call.
export function onPostToolUse(payload, {
  _fs = fs, _now = () => Date.now(), _env = process.env,
  _dir = NUDGE_DIR, _platform = process.platform, _ownStatePath,
} = {}) {
  try {
    const sid = String((payload && payload.session_id) || '');
    if (!sid) return null;
    const tool = String((payload && payload.tool_name) || '');
    if (tool === 'Read') {
      onRead(payload, sid, { _fs, _now, _env, _dir, _platform, _ownStatePath });
      return null;
    }
    if (WRITE_TOOLS.has(tool)) return onWrite(payload, { _fs, _env, _platform });
    return null;
  } catch { return null; }
}

function onRead(payload, sid, { _fs, _now, _env, _dir, _platform, _ownStatePath }) {
  const file = payload && payload.tool_response && payload.tool_response.file;
  if (!file) return; // an errored Read fires no PostToolUse at all (P0)
  const filePath = String(file.filePath || (payload.tool_input && payload.tool_input.file_path) || '');
  if (!isStatePath(filePath, { _env, _platform })) return;
  let start = Number(file.startLine) || 0;
  let num = Number(file.numLines) || 0;
  let total = Number(file.totalLines) || 0;
  // A no-offset Read carries the content but no pagination; count it as the
  // whole file so a genuine full read always clears the gate.
  if (start < 1 || num < 1) {
    if (typeof file.content !== 'string') return;
    start = 1;
    num = total > 0 ? total : lineCount(file.content);
    total = total || num;
  }
  const end = start + num - 1;
  const key = stateKey(filePath, _platform);
  const log = readLogPath(sid, _dir);
  const gateFile = gatePath(sid, _dir);
  const gate = readJson(_fs, gateFile);
  // Coverage only counts against the gate that was armed after it: a Read from
  // before compaction must not satisfy the post-compact gate.
  let gen = gate && typeof gate.key === 'string'
    ? (gate.key === key ? String(gate.gen || '') : '')
    : null;

  if (gen === null) {
    // Arm only on a partial Read of the session's OWN STATE before its first
    // act: the file the operator picked must be finished. A coordinator's peek
    // at a peer's STATE arms nothing, and a full Read needs no gate.
    let own = _ownStatePath;
    if (own === undefined) {
      try { own = resolveOwnStatePath(String(payload.cwd || ''), sid); } catch { own = ''; }
    }
    if (own && stateKey(own, _platform) === key && !fileExists(_fs, actedPath(sid, _dir))) {
      const ranges = mergeRanges([...coverageRanges(_fs, log, key), [start, end]]);
      const known = total || ranges.reduce((m, [, e]) => Math.max(m, e), 0);
      if (!(known > 0 && !firstGap(ranges, known))) {
        gen = `${_now()}-${Math.random().toString(36).slice(2)}`;
        writeJsonAtomic(_fs, gateFile, { key, path: filePath, armedAt: _now(), total: known, gen });
      }
    }
    if (gen === null) gen = '';
  }
  appendCoverage(_fs, log, { path: key, start, end, total, ts: _now(), gen });
}

// The post-write check judges shape only. Judging "changed" per write would
// fail the header-only first Edit of a correct multi-Edit checkpoint; that
// question belongs to the Stop, against the round's pre-image.
function onWrite(payload, { _fs, _env, _platform }) {
  const filePath = String((payload.tool_input && payload.tool_input.file_path) || '');
  if (!isStatePath(filePath, { _env, _platform })) return null;
  let body = '';
  try { body = _fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  const docsDir = docsDirPath(filePath);
  let docsFiles = [];
  if (docsDir) { try { docsFiles = _fs.readdirSync(docsDir); } catch { /* no docs dir yet */ } }
  const { errors } = lintState(body, { docsDir, docsFiles });
  if (!errors.length) return null;
  return {
    decision: 'block',
    reason: `STATE lint failed — fix it before this checkpoint counts:\n${errors.join('\n')}`,
  };
}

// --- PreToolUse -------------------------------------------------------------

// Returns a PreToolUse deny decision, or null to allow the call.
export function onPreToolUse(payload, {
  _fs = fs, _now = () => Date.now(), _env = process.env,
  _dir = NUDGE_DIR, _platform = process.platform, _settings = {}, _ownStatePath,
} = {}) {
  try {
    return preToolUse(payload, { _fs, _now, _env, _dir, _platform, _settings, _ownStatePath });
  } catch { return null; } // any internal error fails open
}

function preToolUse(payload, { _fs, _now, _env, _dir, _platform, _settings, _ownStatePath }) {
  const sid = String((payload && payload.session_id) || '');
  const tool = String((payload && payload.tool_name) || '');
  if (!sid || !tool) return null;
  if (_env && _env.CORRELATION_ID) return null; // headless pipeline sessions
  if (_settings && _settings.checkpoint && _settings.checkpoint.readGate === false) return null;

  const gate = readJson(_fs, gatePath(sid, _dir));
  if (gate && typeof gate.key === 'string') {
    const age = _now() - Number(gate.armedAt || 0);
    if (!(age <= GATE_MAX_AGE_MS)) {
      removeFile(_fs, gatePath(sid, _dir)); // stale: never hold a session forever
    } else if (!isAllowedTool(tool)) {
      const denial = denyWhileUnread(gate, sid, { _fs, _dir });
      if (denial) return denial;
      // Covered, or the file is gone/unreadable at deny time: the gate can no
      // longer be satisfied, so release it.
      removeFile(_fs, gatePath(sid, _dir));
    }
  }

  if (!isAllowedTool(tool)) {
    markActed(_fs, sid, _dir);
    if (WRITE_TOOLS.has(tool)) {
      recordPreImage(payload, sid, { _fs, _now, _platform, _dir, _ownStatePath });
    }
  }
  return null;
}

function denyWhileUnread(gate, sid, { _fs, _dir }) {
  let body = '';
  try { body = _fs.readFileSync(gate.path, 'utf8'); } catch { return null; }
  const ranges = coverageRanges(_fs, readLogPath(sid, _dir), gate.key, String(gate.gen || ''));
  const covered = ranges.reduce((m, [, e]) => Math.max(m, e), 0);
  const total = Math.max(Number(gate.total) || 0, covered, lineCount(body));
  const gap = firstGap(ranges, total);
  if (!gap) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `Read \`${gate.path}\` in full before acting — lines ${gap.a}-${gap.b} of ${total} are `
        + `unread; next: Read with offset ${gap.a}.`,
    },
  };
}

function markActed(_fs, sid, dir) {
  const p = actedPath(sid, dir);
  if (!p) return;
  try {
    _fs.mkdirSync(path.dirname(p), { recursive: true });
    _fs.closeSync(_fs.openSync(p, 'wx')); // exclusive: only the first act writes
  } catch { /* already acted */ }
}

// The round's pre-image, recorded once — on the first write to the session's
// OWN STATE file since the last stand-down. Later writes leave it alone, so a
// multi-Edit checkpoint that starts with a header edit still passes.
function recordPreImage(payload, sid, { _fs, _now, _platform, _dir, _ownStatePath }) {
  const target = String((payload.tool_input && payload.tool_input.file_path) || '');
  if (!target) return;
  let own = _ownStatePath;
  if (own === undefined) {
    try { own = resolveOwnStatePath(String(payload.cwd || ''), sid); } catch { own = ''; }
  }
  // A coordinator writing a peer's STATE must not seed its own round.
  if (!own || stateKey(own, _platform) !== stateKey(target, _platform)) return;
  const p = preImagePath(sid, _dir);
  if (!p || fileExists(_fs, p)) return;
  let body = '';
  try { body = _fs.readFileSync(target, 'utf8'); } catch { return; } // a mint: nothing to compare
  publishOnce(_fs, p, { hash: liveSectionsHash(body), path: target, ts: _now() });
}

// --- Stop-hook API ----------------------------------------------------------

export function readPreImage(sessionId, { _fs = fs, _dir = NUDGE_DIR } = {}) {
  const p = preImagePath(sessionId, _dir);
  if (!p) return null;
  const rec = readJson(_fs, p);
  return rec && typeof rec.hash === 'string' ? rec : null;
}

export function clearPreImage(sessionId, { _fs = fs, _dir = NUDGE_DIR } = {}) {
  const p = preImagePath(sessionId, _dir);
  if (!p) return false;
  try { _fs.unlinkSync(p); return true; } catch { return false; }
}

// --- arming from the compact hook ------------------------------------------

export function armGate(sessionId, statePath, {
  _fs = fs, _now = () => Date.now(), _dir = NUDGE_DIR, _platform = process.platform,
} = {}) {
  const p = gatePath(sessionId, _dir);
  if (!p || !statePath) return false;
  // `gen` scopes the gate to coverage recorded after it was armed.
  const gen = `${_now()}-${Math.random().toString(36).slice(2)}`;
  writeJsonAtomic(_fs, p, {
    key: stateKey(statePath, _platform), path: String(statePath), armedAt: _now(), total: 0, gen,
  });
  return true;
}
