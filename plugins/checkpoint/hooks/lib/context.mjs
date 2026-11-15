// Context-window utilisation + cache hit/bust state, derived from transcript `usage`.
// Pure functions + one transcript-tail reader. No injection, no API calls.
import fs from 'node:fs';

import { maxInputTokens } from './claude-catalog.mjs';

const DEFAULT_CONTEXT_WINDOW = 200_000;
export const WARM_RATIO          = 0.5;  // cache_read share that counts as "warm"

// The window Claude Code ships for the model. `[1m]` is an explicit opt-in to 1M
// whatever the catalog says; an id the catalog does not list gets the default.
export function contextWindowFor(model, rows) {
  if (typeof model === 'string' && model.endsWith('[1m]')) return 1_000_000;
  return maxInputTokens(rows, model) ?? DEFAULT_CONTEXT_WINDOW;
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

// Token bands, not percentages: `soon` at trigger - 2r and `now` at trigger - r,
// with r = min(reserve, trigger / 4) so the two lines can never collapse.
// `state` is { trigger, cycle, fired }; the caller persists the returned one.
export function decideCheckpointNudge({ used, trigger, reserve, state } = {}) {
  const prev = state && typeof state === 'object' ? state : {};
  const triggerChanged = prev.trigger != null && prev.trigger !== trigger;
  let cycle = Number.isInteger(prev.cycle) ? prev.cycle : 0;
  let fired = Array.isArray(prev.fired) ? prev.fired.slice() : [];
  if (triggerChanged) { cycle += 1; fired = []; }

  const nextState = () => ({ ...prev, trigger, cycle, fired });
  if (!Number.isFinite(trigger) || trigger <= 0) return { band: null, state: nextState() };

  const want = Number(reserve);
  const r = Number.isFinite(want) && want > 0 ? Math.min(want, trigger / 4) : trigger / 4;
  const soonLine = trigger - 2 * r;
  const nowLine = trigger - r;

  // Usage below `soon` after a band fired means compaction happened — new cycle.
  if (!triggerChanged && fired.length > 0 && used < soonLine) { cycle += 1; fired = []; }

  const reached = used >= nowLine ? 'now' : used >= soonLine ? 'soon' : null;
  const band = reached && !fired.includes(reached) ? reached : null;
  if (band) fired.push(band);

  return { band, state: nextState() };
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
