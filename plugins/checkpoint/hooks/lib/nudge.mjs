// The checkpoint nudge, shared by the UserPromptSubmit and PostToolUse hooks.
// Token bands measured against the session's real compaction trigger, with
// per-session state and exclusive band claims so a band fires exactly once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NUDGE_DIR, readJSON, writeJSON, sanitizeSid } from './paths.mjs';
import { compactTrigger, readSettingsChain } from './compact-trigger.mjs';
import { catalogModels } from './claude-catalog.mjs';
import { decideCheckpointNudge, usageInputTotal } from './context.mjs';
import { SKILL_INVOCATION, SKILL_DISAMBIGUATION } from './skill-ref.mjs';

// Room a checkpoint needs (load skill, read STATE, edit it). Clamped to T/4 by
// the band decision so the two lines can never collapse or invert.
export const DEFAULT_COMPACT_RESERVE_TOKENS = 60_000;

// `checkpoint.*` keys are user-only, so the caller passes the user settings file.
export function reserveTokens(settings) {
  const n = Number(settings && settings.checkpoint && settings.checkpoint.compactReserveTokens);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COMPACT_RESERVE_TOKENS;
}

export function nudgeStatePath(sessionId, dir = NUDGE_DIR) {
  const sid = sanitizeSid(sessionId);
  return sid ? path.join(dir, `${sid}.json`) : '';
}

export function readNudgeState(statePath) {
  const raw = statePath ? readJSON(statePath, {}) : {};
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

// Exclusive create: whichever process wins owns the band, every other gets
// EEXIST. The claim file outlives a lost state write, so it is the real gate.
export function claimBand(sessionId, cycle, band, dir = NUDGE_DIR) {
  const sid = sanitizeSid(sessionId);
  if (!sid) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.closeSync(fs.openSync(path.join(dir, `${sid}.${cycle}.${band}`), 'wx'));
    return true;
  } catch { return false; }
}

const kilo = (n) => Math.round(n / 1000);

export function buildCheckpointNudge(band, used, trigger) {
  const left = Math.max(0, trigger - used);
  const body = band === 'now'
    ? `Compaction in ~${kilo(left)}k tokens. Checkpoint now, before your next tool call: call `
      + `${SKILL_INVOCATION} to write a STATE.md handover. A checkpoint written after compaction `
      + `works from the summary, which has already lost detail.`
    : `Context is ~${kilo(used)}k of ~${kilo(trigger)}k before compaction (~${kilo(left)}k left). `
      + `No need to stop — at your next natural pause, call ${SKILL_INVOCATION} to write a STATE.md `
      + `handover while the full context is still here.`;
  return `${body} ${SKILL_DISAMBIGUATION}`;
}

// Newest usage-bearing turn; `fallbackUsed` covers a session with no usage row
// yet (the caller converts transcript bytes at ~4 bytes per token).
function usagePoint(recentTurns, fallbackUsed) {
  const turns = Array.isArray(recentTurns) ? recentTurns : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const total = t && t.usage ? usageInputTotal(t.usage) : 0;
    if (total > 0) return { used: total, model: t.model };
  }
  return Number.isFinite(fallbackUsed) && fallbackUsed > 0
    ? { used: fallbackUsed, model: undefined }
    : null;
}

// Returns the nudge text, or null when no band is due or this process lost the
// claim. `transcriptBytes` is recorded for the PostToolUse growth throttle.
export function checkpointNudge({
  recentTurns = [], cwd, env = process.env, sessionId = '', settings = {},
  fallbackUsed, transcriptBytes, home = os.homedir(), nudgeDir = NUDGE_DIR,
} = {}) {
  const statePath = nudgeStatePath(sessionId, nudgeDir);
  if (!statePath) return null;

  const point = usagePoint(recentTurns, fallbackUsed);
  if (!point) {
    // No token count to decide on, but the PostToolUse throttle still needs the
    // recorded size or every later tool call re-reads the same tail.
    if (Number.isFinite(transcriptBytes)) {
      const prev = readNudgeState(statePath);
      if (prev.lastSize !== transcriptBytes) writeJSON(statePath, { ...prev, lastSize: transcriptBytes });
    }
    return null;
  }

  const { tokens: trigger } = compactTrigger({
    model: point.model,
    env,
    settingsChain: readSettingsChain(cwd || process.cwd(), home),
    catalog: catalogModels({ HOME: home, USERPROFILE: home }),
  });
  const prev = readNudgeState(statePath);
  const { band, state } = decideCheckpointNudge({
    used: point.used, trigger, reserve: reserveTokens(settings), state: prev,
  });
  const next = Number.isFinite(transcriptBytes) ? { ...state, lastSize: transcriptBytes } : state;

  const text = band && claimBand(sessionId, state.cycle, band, nudgeDir)
    ? buildCheckpointNudge(band, point.used, trigger)
    : null;
  if (JSON.stringify(next) !== JSON.stringify(prev)) writeJSON(statePath, next);
  return text;
}
