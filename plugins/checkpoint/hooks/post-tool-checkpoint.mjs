#!/usr/bin/env node
// PostToolUse hook: the same checkpoint nudge as UserPromptSubmit, so a band
// also lands mid-turn (where autonomous sessions actually compact). It never
// reads or writes STATE_DB, and always exits 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readJSON } from './lib/paths.mjs';
import { readRecentAssistantTurns } from './lib/context.mjs';
import { checkpointNudge, nudgeStatePath, readNudgeState } from './lib/nudge.mjs';
import { BYTES_PER_TOKEN } from './prompt-submit-checkpoint.mjs';
import { onPostToolUse } from './lib/state-guard.mjs';

// Below this much transcript growth the decision is skipped entirely: no tail
// read, no settings read, no write.
export const GROWTH_THROTTLE_BYTES = 64 * 1024;

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

function emit(text) {
  if (!text || !text.trim()) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text },
  }) + '\n');
  process.exit(0);
}

function handle(payload) {
  // The state guard rides this process: a Read's coverage append and a
  // post-write lint block need no extra spawn per tool call, and both must run
  // before the growth throttle can skip the rest.
  let guard = null;
  try { guard = onPostToolUse(payload); } catch { /* fail open */ }
  if (guard && guard.decision) {
    process.stdout.write(JSON.stringify(guard) + '\n');
    process.exit(0);
  }

  if (process.env.CORRELATION_ID) process.exit(0);

  const transcriptPath = String(payload.transcript_path || '');
  const sessionId = String(payload.session_id || '');
  if (!transcriptPath || !sessionId) process.exit(0);

  let size = 0;
  try { size = fs.statSync(transcriptPath).size; } catch { process.exit(0); }

  const lastSize = Number(readNudgeState(nudgeStatePath(sessionId)).lastSize) || 0;
  if (size - lastSize < GROWTH_THROTTLE_BYTES) process.exit(0);

  const settings = readJSON(SETTINGS, {});
  const text = checkpointNudge({
    recentTurns: readRecentAssistantTurns(transcriptPath, 3),
    cwd: String(payload.cwd || ''),
    env: process.env,
    sessionId,
    settings,
    fallbackUsed: Math.floor(size / BYTES_PER_TOKEN),
    transcriptBytes: size,
  });
  emit(text);
}

function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { stdin += c; });
  process.stdin.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(stdin); } catch { process.exit(0); }
    try { handle(payload); } catch { process.exit(0); }
  });
  process.stdin.on('error', () => process.exit(0));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
