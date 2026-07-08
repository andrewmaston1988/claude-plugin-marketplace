#!/usr/bin/env node
// Stop hook: when a batch of substantial work finishes without a checkpoint,
// block the stop once and ask the model to judge whether a significant feature
// just completed — and if so, invoke the checkpoint skill to write it up.
// The hook detects mechanically (commits / file edits); significance is the
// model's call. Loop-safe via stop_hook_active; skips if CORRELATION_ID set.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

import {
  STATE_DB, readJSON, writeJSON, getSessionState, resolveOwnStatePath,
} from './lib/paths.mjs';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

export const EDIT_NUDGE_THRESHOLD = 10;             // file mutations, absent a commit
export const NUDGE_COOLDOWN_MS    = 15 * 60 * 1000; // between block-once nudges

const MUTATION_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const SHELL_TOOLS    = new Set(['Bash', 'PowerShell']);

// --- testable pure helpers (exported) ---

// Count work signals in a transcript JSONL slice: file-mutation tool uses and
// `git commit` shell commands, assistant turns only.
export function scanWorkSignals(text) {
  let edits = 0, commits = 0;
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
      else if (SHELL_TOOLS.has(item.name) && /\bgit\s+commit\b/.test(String(item.input?.command || ''))) commits++;
    }
  }
  return { edits, commits };
}

export function decideStopNudge({ edits, commits, lastNudgeTs, now }) {
  if (commits < 1 && edits < EDIT_NUDGE_THRESHOLD) return false;
  return !lastNudgeTs || (now - lastNudgeTs) > NUDGE_COOLDOWN_MS;
}

export function buildStopNudge({ edits, commits }) {
  const signals = commits
    ? `${commits} commit${commits === 1 ? '' : 's'} and ${edits} file edit${edits === 1 ? '' : 's'}`
    : `${edits} file edits`;
  return `A batch of substantial work just finished (${signals} since the last checkpoint) and no `
    + `STATE.md captures it. If this completed a significant feature or milestone, invoke the `
    + `**checkpoint** skill now and write up what was completed — the completion write-up is the `
    + `most valuable handover a fresh session can inherit. If the work is still mid-flight or `
    + `nothing significant landed, just stop.`;
}

// Epoch ms of the UTC stamp embedded in a STATE filename; 0 if not a STATE name.
export function stateStampMs(basename) {
  const m = String(basename || '').match(/_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.md$/);
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

async function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) stdin += c;

  let payload = {};
  try { payload = JSON.parse(stdin); } catch { process.exit(0); }
  if (process.env.CORRELATION_ID) process.exit(0);
  if (payload.stop_hook_active) process.exit(0);

  const settings = readJSON(SETTINGS, {});
  if (settings?.['checkpoint']?.stopCheckpoint === false) process.exit(0);

  const transcriptPath = String(payload.transcript_path || '');
  const sessionId = String(payload.session_id || '');
  const cwd = String(payload.cwd || process.cwd());
  if (!transcriptPath || !sessionId) process.exit(0);

  let size = 0;
  try { size = fs.statSync(transcriptPath).size; } catch { process.exit(0); }

  const now = Date.now();
  const state = readJSON(STATE_DB, {});
  const sState = getSessionState(state, sessionId);
  let offset = sState.stopScanOffset || 0;
  if (offset > size) offset = 0; // transcript rotated/truncated — rescan

  let text = '';
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(size - offset);
    try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { try { fs.closeSync(fd); } catch {} }
    text = buf.toString('utf8');
  } catch { process.exit(0); }

  const { edits, commits } = scanWorkSignals(text);
  sState.stopScanOffset = size;
  sState.stopEdits = (sState.stopEdits || 0) + edits;
  sState.stopCommits = (sState.stopCommits || 0) + commits;

  // A checkpoint written since we last looked resets the ledger — the work is captured.
  const ownState = resolveOwnStatePath(cwd, sessionId);
  const stamp = ownState && fs.existsSync(ownState) ? stateStampMs(path.basename(ownState)) : 0;
  if (stamp && stamp !== (sState.lastStateStampMs || 0)) {
    sState.lastStateStampMs = stamp;
    sState.stopEdits = 0;
    sState.stopCommits = 0;
    state[sessionId] = sState;
    writeJSON(STATE_DB, state);
    process.exit(0);
  }

  const fire = decideStopNudge({
    edits: sState.stopEdits, commits: sState.stopCommits,
    lastNudgeTs: sState.lastStopNudgeTs || 0, now,
  });

  if (fire) {
    const reason = buildStopNudge({ edits: sState.stopEdits, commits: sState.stopCommits });
    sState.lastStopNudgeTs = now;
    sState.stopEdits = 0;
    sState.stopCommits = 0;
    state[sessionId] = sState;
    writeJSON(STATE_DB, state);
    process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
    process.exit(0);
  }

  state[sessionId] = sState;
  writeJSON(STATE_DB, state);
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
