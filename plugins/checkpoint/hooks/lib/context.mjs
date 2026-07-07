// Context-window utilisation + cache hit/bust state, derived from transcript `usage`.
// Pure functions + one transcript-tail reader. No injection, no API calls.
import fs from 'node:fs';

const DEFAULT_CONTEXT_WINDOW = 200_000;
export const CONTEXT_NUDGE_BANDS = [85, 95]; // ascending; fire once per band per window cycle
export const WARM_RATIO          = 0.5;  // cache_read share that counts as "warm"

// [substring, window]. First match wins; unknown -> default.
const MODEL_WINDOWS = [
  ['claude-opus-4',   1_000_000],
  ['claude-sonnet-4',   200_000],
  ['claude-haiku-4',    200_000],
  ['claude-fable-5',  1_000_000],
];

export function contextWindowFor(model) {
  if (typeof model === 'string') {
    for (const [sub, win] of MODEL_WINDOWS) if (model.includes(sub)) return win;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

export function usageInputTotal(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
}

export function contextUtilization(usage, windowTokens) {
  const total = usageInputTotal(usage);
  if (!total || !windowTokens) return 0;
  return Math.round((100 * total) / windowTokens);
}

export function decideCheckpointNudge(pct, lastFiredPct) {
  // Utilisation falling below the last fired point means compaction reset the window — new cycle.
  if (lastFiredPct != null && pct < lastFiredPct) lastFiredPct = null;
  let band = null;
  for (const b of CONTEXT_NUDGE_BANDS) if (pct >= b) band = b;
  if (band == null) return false;
  return lastFiredPct == null || band > lastFiredPct;
}

// 'warm' | 'busted' | 'cold' (cold = no usage tokens at all).
export function cacheState(usage) {
  const total = usageInputTotal(usage);
  if (!total) return 'cold';
  const ratio = (usage.cache_read_input_tokens || 0) / total;
  return ratio >= WARM_RATIO ? 'warm' : 'busted';
}

// A *fresh* bust: prior turn was warm, this turn is busted, and we re-cached a lot.
export function detectCacheBust(curUsage, priorUsage) {
  if (!curUsage || !priorUsage) return false;
  return cacheState(priorUsage) === 'warm'
    && cacheState(curUsage) === 'busted'
    && (curUsage.cache_creation_input_tokens || 0) > (curUsage.cache_read_input_tokens || 0);
}

// Read the tail of a transcript JSONL and return the last `count` assistant
// turns that carry a usage object: [{ model, usage, ts }]. Oldest-first.
export function readRecentAssistantTurns(transcriptPath, count = 2, tailBytes = 200_000) {
  try {
    const stat = fs.statSync(transcriptPath);
    const start = Math.max(0, stat.size - tailBytes);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(stat.size - start);
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { try { fs.closeSync(fd); } catch {} }
    const turns = [];
    for (const line of buf.toString('utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let e;
      try { e = JSON.parse(t); } catch { continue; }
      const msg = e && e.message;
      if (msg && msg.role === 'assistant' && msg.usage && usageInputTotal(msg.usage) > 0) {
        turns.push({ model: msg.model, usage: msg.usage, ts: e.timestamp || null });
      }
    }
    return turns.slice(-count);
  } catch {
    return [];
  }
}
