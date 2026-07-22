#!/usr/bin/env node
// UserPromptSubmit hook: context nudge, post-compact pickup, keepalive (opt-in). Always exits 0; skips if CORRELATION_ID set.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  STATE_DB, MARKER, KEEPALIVE_LOG,
  readJSON, writeJSON, getSessionState, appendJSONL,
} from './lib/paths.mjs';
import {
  nextDelay, keepaliveAction, cadenceFor, resolveTtlSource, offerOverdue,
} from './lib/cadence.mjs';
import {
  contextWindowFor, contextUtilization, decideCheckpointNudge, readRecentAssistantTurns,
} from './lib/context.mjs';
import { SKILL_ID, SKILL_DISAMBIGUATION } from './lib/skill-ref.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(HERE, 'templates');
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

// Byte-fallback threshold (used only when no usage row is available yet).
const BYTES_THRESHOLD = 2_000_000;

// Honest provenance for the {ttlNote} template slot, keyed by resolveTtlSource().source.
export const TTL_NOTES = {
  settings: 'pinned by the checkpoint.keepaliveTtlSecs setting',
  detected: 'detected from the cache-bucket usage in the transcript',
  'last-known': 'carried over from the last cache-bucket signal seen this session',
  default: 'no cache-bucket usage rows yet, so this is a conservative default — the first tick reads the real bucket and stretches the cadence',
};

function readTemplate(name) {
  try { return fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf8'); } catch { return ''; }
}

// --- testable pure helpers (exported) ---

// Prefer usage-derived utilisation; fall back to a coarse byte estimate.
export function resolveUtilisation(recentTurns, transcriptBytes) {
  const last = recentTurns[recentTurns.length - 1];
  if (last && last.usage) {
    const pct = contextUtilization(last.usage, contextWindowFor(last.model));
    if (pct > 0) return { pct, source: 'usage' };
  }
  const pct = transcriptBytes >= BYTES_THRESHOLD
    ? Math.min(100, 75 + Math.floor((transcriptBytes - BYTES_THRESHOLD) / 200_000))
    : Math.floor((transcriptBytes / BYTES_THRESHOLD) * 75);
  return { pct, source: 'bytes' };
}

export function buildCheckpointNudge(pct) {
  return `Context is ~${pct}% full. No need to stop — at your next natural pause, call the Skill `
    + `tool with skill="checkpoint:checkpoint" to write a STATE.md handover so a fresh session can `
    + `pick up cleanly. ${SKILL_DISAMBIGUATION}`;
}

function emitContext(ctx) {
  if (ctx.trim()) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx },
    }) + '\n');
  }
  process.exit(0);
}

async function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) stdin += c;

  let payload = {};
  try { payload = JSON.parse(stdin); } catch { process.exit(0); }
  if (process.env.CORRELATION_ID) process.exit(0);

  const prompt = String(payload.prompt || '');
  const transcriptPath = String(payload.transcript_path || '');
  const sessionId = String(payload.session_id || '');

  const settings = readJSON(SETTINGS, {});
  const keepaliveEnabled = settings?.['checkpoint']?.keepalive === true;
  const isTick = prompt.startsWith('Cache keepalive tick');
  if (isTick && !keepaliveEnabled) process.exit(0);

  const now = Date.now();
  const state = readJSON(STATE_DB, {});
  const sState = sessionId ? getSessionState(state, sessionId) : null;

  let prevUserIdleSecs = Infinity, prevSinceAnySecs = Infinity, prevInjectGap = 0;
  if (sState) {
    prevUserIdleSecs = sState.userTs ? (now - sState.userTs) / 1000 : Infinity;
    prevSinceAnySecs = sState.lastActivityTs ? (now - sState.lastActivityTs) / 1000 : Infinity;
    prevInjectGap = sState.lastInjectTs ? (now - sState.lastInjectTs) / 1000 : 0;
    sState.lastActivityTs = now;
    if (!isTick) sState.userTs = now;
    state[sessionId] = sState;
  }

  let ctx = '';

  // Read a few turns: the last one may be a pure cache-hit with no bucket signal.
  const recent = transcriptPath ? readRecentAssistantTurns(transcriptPath, 3) : [];

  // --- 3. Keepalive (opt-in) ---
  if (keepaliveEnabled && sState) {
    const { ttlSecs: ttl, source: ttlSource } = resolveTtlSource(
      Number(settings?.checkpoint?.keepaliveTtlSecs),
      recent.map(t => t.usage),
      sState.lastTtlSecs,
    );
    sState.lastTtlSecs = ttl;
    const cad = cadenceFor(ttl, {
      idleStopSecs: Number(settings?.checkpoint?.keepaliveIdleStopSecs) || undefined,
    });
    // Decide before mutating: a tick is the answer to the offer that preceded it.
    const overdue = offerOverdue(Boolean(sState.injectPending), prevInjectGap, sState.lastInjectedDelay, cad);
    if (isTick) sState.injectPending = false;
    const action = keepaliveAction(prevUserIdleSecs, prevSinceAnySecs, isTick, cad, overdue);
    if (action === 'inject') {
      const delay = nextDelay(prevInjectGap, sState.lastInjectedDelay, cad);
      const initTmpl = readTemplate('keepalive-init.md');
      const tickTmpl = readTemplate('keepalive-tick.md').trim();
      if (initTmpl && tickTmpl) {
        ctx += initTmpl
          .replace(/\{delay\}/g, String(delay))
          .replace(/\{ttl\}/g, String(cad.ttlSecs))
          .replace(/\{ttlNote\}/g, TTL_NOTES[ttlSource] || ttlSource)
          .replace(/\{tick\}/g, tickTmpl);
      }
      // Log every offer, not just answered ones — an ignored offer must be visible.
      appendJSONL(KEEPALIVE_LOG, {
        ts: now, session: sessionId,
        event: isTick ? 'tick' : (overdue ? 'retry' : 'offer'),
        observedGap: Math.round(prevInjectGap),
        lastInjectedDelay: sState.lastInjectedDelay || 0,
        overshoot: Math.max(0, Math.round(prevInjectGap) - (sState.lastInjectedDelay || 0)),
        nextDelay: delay,
        ttlSecs: cad.ttlSecs,
        ttlSource,
      });
      sState.lastInjectTs = now;
      sState.injectPending = true;
      sState.lastInjectedDelay = delay;
      state[sessionId] = sState;
    }
    if (isTick) { sState.lastTickTs = now; state[sessionId] = sState; }
  }

  // Ticks are for cache warmth only — skip the real-work jobs.
  if (isTick) { writeJSON(STATE_DB, state); emitContext(ctx); return; }

  // --- 1. Context-pressure nudge ---
  let transcriptBytes = 0;
  try { if (transcriptPath) transcriptBytes = fs.statSync(transcriptPath).size; } catch {}
  const { pct } = resolveUtilisation(recent, transcriptBytes);
  if (sState && decideCheckpointNudge(pct, sState.lastFiredPct)) {
    sState.lastFiredPct = pct;
    state[sessionId] = sState;
    const nudge = buildCheckpointNudge(pct);
    ctx = ctx ? `${ctx}\n\n${nudge}` : nudge;
  }

  // --- 2. Post-compact pickup ---
  if (fs.existsSync(MARKER)) {
    try { fs.unlinkSync(MARKER); } catch {}
    const note = '**Compaction just happened.** A skeletal STATE.md was written by the PreCompact '
      + 'backstop. While your post-compact summary is still in context, call the Skill tool with '
      + `skill="${SKILL_ID}" to reconcile it into a richer STATE.md. ${SKILL_DISAMBIGUATION}`;
    ctx = ctx ? `${ctx}\n\n${note}` : note;
  }

  writeJSON(STATE_DB, state);
  emitContext(ctx);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
