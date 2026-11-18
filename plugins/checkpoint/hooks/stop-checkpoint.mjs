#!/usr/bin/env node
// Stop hook: when a batch of substantial work finishes without a checkpoint,
// block the stop once and ask the model to judge whether a significant feature
// just completed — and if so, invoke the checkpoint skill to write it up.
// Signals are mechanical (commits / edits / answered questions); significance is
// the model's call. A stamp is a claim, not evidence: it stands down only when the
// lint passes and [live] sections moved. Loop-safe; skips under CORRELATION_ID.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

import {
  STATE_DB, NUDGE_DIR, readJSON, writeJSON, getSessionState, resolveOwnStatePath,
  docsDirPath, savedStamp,
} from './lib/paths.mjs';
import { SECTIONS, lintState, liveSectionsHash } from './lib/state-lint.mjs';
import { readPreImage, clearPreImage } from './lib/state-guard.mjs';
import { SKILL_ID, SKILL_DISAMBIGUATION } from './lib/skill-ref.mjs';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

export const EDIT_NUDGE_THRESHOLD = 10;             // file mutations, absent a commit
export const NUDGE_COOLDOWN_MS    = 15 * 60 * 1000; // between block-once nudges

const MUTATION_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const SHELL_TOOLS    = new Set(['Bash', 'PowerShell']);
// An operator ruling changes the state a handover must carry.
const RULING_TOOLS   = new Set(['AskUserQuestion']);

// Every block reason names the seven sections, so a reconcile has to answer
// each rather than advance a stamp.
const SEVEN_SECTIONS = SECTIONS.join(', ');

// --- testable pure helpers (exported) ---

// Count work signals in a transcript JSONL slice: file-mutation tool uses,
// `git commit` shell commands, and answered operator questions; assistant
// turns only.
export function scanWorkSignals(text) {
  let edits = 0, commits = 0, rulings = 0;
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch { continue; }
    const msg = e && e.message;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const item of msg.content) {
      if (!item || item.type !== 'tool_use') continue;
      if (MUTATION_TOOLS.has(item.name)) edits++;
      else if (RULING_TOOLS.has(item.name)) rulings++;
      else if (SHELL_TOOLS.has(item.name) && /\bgit\s+commit\b/.test(String(item.input?.command || ''))) commits++;
    }
  }
  return { edits, commits, rulings };
}

export function decideStopNudge({ edits, commits, rulings = 0, lastNudgeTs, now }) {
  if (commits < 1 && (edits + rulings) < EDIT_NUDGE_THRESHOLD) return false;
  return !lastNudgeTs || (now - lastNudgeTs) > NUDGE_COOLDOWN_MS;
}

// One block reason per cause: no checkpoint at all, a header-only write, or a
// STATE that fails its own lint.
export function buildStopNudge({
  edits = 0, commits = 0, rulings = 0,
  cause = 'no-checkpoint', errors = [], since = 'the last accepted checkpoint',
} = {}) {
  const signals = commits
    ? `${commits} commit${commits === 1 ? '' : 's'} and ${edits} file edit${edits === 1 ? '' : 's'}`
    : `${edits} file edit${edits === 1 ? '' : 's'}`;
  const rulingNote = rulings
    ? `${signals} and ${rulings} operator ruling${rulings === 1 ? '' : 's'}`
    : signals;
  const sections = `Answer each of the seven sections — ${SEVEN_SECTIONS} — and rewrite any that changed.`;

  if (cause === 'lint') {
    const shown = errors.slice(0, 5);
    const more = errors.length > shown.length
      ? `\n(+${errors.length - shown.length} more lint error${errors.length - shown.length === 1 ? '' : 's'})`
      : '';
    return `A checkpoint was written but its STATE lint failed, so it does not count yet:\n`
      + `${shown.join('\n')}${more}\n`
      + `Call the Skill tool with skill="${SKILL_ID}", fix every error, and reconcile the whole file. `
      + `${sections} ${SKILL_DISAMBIGUATION}`;
  }

  if (cause === 'header-only') {
    return `Only the header moved — CURRENT STATE, NEXT ACTIONS and KEY FILES are unchanged since `
      + `${since}, so this checkpoint captured no new state. Re-read the whole STATE file, rewrite its `
      + `[live] sections from what is true now, file any narrative to the docs dir and link it, then `
      + `stamp it. ${sections} Call the Skill tool with skill="${SKILL_ID}". ${SKILL_DISAMBIGUATION}`;
  }

  return `A batch of substantial work just finished (${rulingNote} since the last checkpoint) and no `
    + `STATE.md captures it. If this completed a significant feature or milestone, call the Skill `
    + `tool with skill="${SKILL_ID}" now and write up what was completed — the completion write-up `
    + `is the most valuable handover a fresh session can inherit. ${sections} If the work is still mid-flight `
    + `or nothing significant landed, just stop. ${SKILL_DISAMBIGUATION}`;
}

// Judge a checkpoint already on disk. The lint decides whether the file is
// shaped like a checkpoint; the live hash decides whether it captured anything.
// `before` falls back from the round's pre-image to the last accepted hash; with
// neither (a node:fs write before any stand-down) that rule is skipped.
export function judgeCheckpoint({
  text, preImageHash = '', lastLiveHash = '', since = 'the last accepted checkpoint',
  docsDir = '', docsFiles = [],
} = {}) {
  const { errors } = lintState(text, { docsDir, docsFiles });
  const liveHash = liveSectionsHash(text);
  if (errors.length) {
    return { standDown: false, cause: 'lint', liveHash, reason: buildStopNudge({ cause: 'lint', errors }) };
  }
  const before = typeof preImageHash === 'string' && preImageHash
    ? preImageHash
    : (typeof lastLiveHash === 'string' ? lastLiveHash : '');
  if (before && before === liveHash) {
    return {
      standDown: false, cause: 'header-only', liveHash,
      reason: buildStopNudge({ cause: 'header-only', since }),
    };
  }
  return { standDown: true, cause: 'moved', liveHash, reason: '' };
}

// Epoch ms of the UTC stamp embedded in a STATE filename; 0 if not a STATE name.
export function stateStampMs(basename) {
  const m = String(basename || '').match(/_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.md$/);
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

// The hook body, with fs/clock/env/state injected so the stand-down rules can be
// tested without touching the real home. Returns `{ reason }` to block the stop,
// null to allow it.
export function runStop(payload = {}, {
  _fs = fs, _now = () => Date.now(), _env = process.env,
  _db = STATE_DB, _dir = NUDGE_DIR, _settings, _ownStatePath,
} = {}) {
  try {
    if (_env.CORRELATION_ID) return null;
    if (payload.stop_hook_active) return null;

    let settings = _settings;
    if (settings === undefined) settings = readJSON(SETTINGS, {});
    if (settings && settings.checkpoint && settings.checkpoint.stopCheckpoint === false) return null;

    const transcriptPath = String(payload.transcript_path || '');
    const sessionId = String(payload.session_id || '');
    const cwd = String(payload.cwd || process.cwd());
    if (!transcriptPath || !sessionId) return null;

    let size = 0;
    try { size = _fs.statSync(transcriptPath).size; } catch { return null; }

    const now = _now();
    const state = readJSON(_db, {});
    const sState = getSessionState(state, sessionId);
    let offset = sState.stopScanOffset || 0;
    if (offset > size) offset = 0; // transcript rotated/truncated — rescan

    let text = '';
    try {
      const fd = _fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(size - offset);
      try { _fs.readSync(fd, buf, 0, buf.length, offset); } finally { try { _fs.closeSync(fd); } catch {} }
      text = buf.toString('utf8');
    } catch { return null; }

    const { edits, commits, rulings } = scanWorkSignals(text);
    sState.stopScanOffset = size;
    sState.stopEdits = (sState.stopEdits || 0) + edits;
    sState.stopCommits = (sState.stopCommits || 0) + commits;
    sState.stopRulings = (sState.stopRulings || 0) + rulings;

    // A checkpoint written since we last looked must reconcile, not just stamp.
    let ownState = _ownStatePath;
    if (ownState === undefined) {
      try { ownState = resolveOwnStatePath(cwd, sessionId); } catch { ownState = ''; }
    }
    const stamp = ownState && _fs.existsSync(ownState) ? stateStampMs(path.basename(ownState)) : 0;
    if (stamp && stamp !== (sState.lastStateStampMs || 0)) {
      let body = '';
      try { body = _fs.readFileSync(ownState, 'utf8'); } catch { return null; } // fail open

      const preImage = readPreImage(sessionId, { _dir });
      const docsDir = docsDirPath(ownState);
      let docsFiles = [];
      if (docsDir) { try { docsFiles = _fs.readdirSync(docsDir); } catch { /* no docs dir yet */ } }
      const since = sState.lastStateStampMs
        ? savedStamp(new Date(sState.lastStateStampMs))
        : savedStamp(new Date((preImage && preImage.ts) || now));

      const verdict = judgeCheckpoint({
        text: body,
        preImageHash: preImage && preImage.hash,
        lastLiveHash: sState.lastLiveHash,
        since, docsDir, docsFiles,
      });

      if (!verdict.standDown) {
        // The work is not captured: keep the ledger and the pre-image so the
        // retry is judged against the same round.
        state[sessionId] = sState;
        writeJSON(_db, state);
        return { reason: verdict.reason };
      }

      sState.lastStateStampMs = stamp;
      sState.lastLiveHash = verdict.liveHash;
      sState.stopEdits = 0;
      sState.stopCommits = 0;
      sState.stopRulings = 0;
      state[sessionId] = sState;
      writeJSON(_db, state);
      clearPreImage(sessionId, { _dir });
      return null;
    }

    const fire = decideStopNudge({
      edits: sState.stopEdits, commits: sState.stopCommits, rulings: sState.stopRulings,
      lastNudgeTs: sState.lastStopNudgeTs || 0, now,
    });

    if (fire) {
      const reason = buildStopNudge({
        edits: sState.stopEdits, commits: sState.stopCommits, rulings: sState.stopRulings,
      });
      sState.lastStopNudgeTs = now;
      sState.stopEdits = 0;
      sState.stopCommits = 0;
      sState.stopRulings = 0;
      state[sessionId] = sState;
      writeJSON(_db, state);
      return { reason };
    }

    state[sessionId] = sState;
    writeJSON(_db, state);
    return null;
  } catch { return null; } // any internal error fails open
}

async function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) stdin += c;

  let payload = {};
  try { payload = JSON.parse(stdin); } catch { process.exit(0); }

  const out = runStop(payload);
  if (out && out.reason) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: out.reason }) + '\n');
  }
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
