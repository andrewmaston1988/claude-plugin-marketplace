// Per-session firing budget shared by the nudge hooks (workflow-nudge, agent-nudge).
// A nudge is a speed bump: it fires a couple of times, then gets out of the way for
// the rest of the session. Each hook owns its own marker file so the two budgets are
// independent.
//
// Marker format is { sessionId: { n, t } }. A bare number is the legacy shape
// workflow-nudge wrote (timestamp, implicitly one firing) and reads as n = 1, so an
// upgrade mid-session does not hand the operator a fresh budget.
import fs from 'node:fs';
import path from 'node:path';

export const NUDGE_CAP = 2;
const MAX_AGE_MS = 86_400_000; // entries older than a day are dead sessions

export function firedCount(seen, sessionId) {
  const entry = seen?.[sessionId];
  if (typeof entry === 'number') return 1;
  const n = entry?.n;
  return Number.isFinite(n) ? n : 0;
}

export function underCap(seen, sessionId, cap = NUDGE_CAP) {
  return firedCount(seen, sessionId) < cap;
}

// Record one firing. Marker failure must never break the nudge, so this swallows.
export function recordFiring(file, sessionId, { now = Date.now() } = {}) {
  try {
    let seen = {};
    try { seen = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first run */ }
    seen[sessionId] = { n: firedCount(seen, sessionId) + 1, t: now };
    for (const [k, v] of Object.entries(seen)) {
      const t = typeof v === 'number' ? v : v?.t;
      if (!Number.isFinite(t) || now - t > MAX_AGE_MS) delete seen[k];
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(seen), 'utf8');
  } catch { /* nudging matters more than remembering we nudged */ }
}
