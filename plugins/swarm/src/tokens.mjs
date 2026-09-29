// Token bookkeeping: the four-bucket usage shape, the arithmetic over it, and
// the accumulator a runner adapter drives. Kept apart from the stream parsers so
// a caller that only counts tokens never opens the JSONL machinery.

export function emptyTokens() {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

// API usage object -> our token shape. Tolerates absent/partial usage.
export function usageTokens(usage) {
  return {
    input: usage?.input_tokens || 0,
    output: usage?.output_tokens || 0,
    cacheCreation: usage?.cache_creation_input_tokens || 0,
    cacheRead: usage?.cache_read_input_tokens || 0,
  };
}

export function addTokens(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}

// Headline count: tokens the provider processed. `input` means UNCACHED input on
// every provider (codexUsage subtracts the cached subset OpenAI folds into it), so
// the four fields are disjoint and this sum counts each processed token once.
// Tolerates partial shapes — a summary row may omit buckets.
export function tokenTotal(t) {
  return t ? (t.input || 0) + (t.output || 0) + (t.cacheCreation || 0) + (t.cacheRead || 0) : 0;
}

// Work tokens (input + output + cache writes), excluding cache reads. For cost
// estimation, where a re-served prefix really is cheaper than fresh input.
export function workTokens(t) {
  return t ? (t.input || 0) + (t.output || 0) + (t.cacheCreation || 0) : 0;
}

// Runner usage contract — two accumulation disciplines, chosen by emission shape:
//  - delta emitters (Claude: one usage per message) -> SUM per id, latest-per-id
//    winning (this accumulator);
//  - cumulative emitters (Codex: a running total per event) -> REPLACE with the
//    latest event (recordUsage in the Codex parser).
// A new adapter must pick by what its provider emits; summing a cumulative
// stream counts every turn again, replacing a delta stream drops all but one.
//
// stream-json may re-emit an assistant message (same id) as content blocks
// complete; latest usage per id wins so re-emits never double-count.
export function createUsageAccumulator() {
  const byMsg = new Map();
  return {
    record(id, usage) {
      byMsg.set(id, usageTokens(usage));
    },
    totals() {
      let t = emptyTokens();
      for (const u of byMsg.values()) t = addTokens(t, u);
      return t;
    },
  };
}

// The result event's usage aggregates the whole session — authoritative when
// present; the live accumulation is the fallback (timeout, kill, old CLI).
export function pickFinalTokens(resultUsage, accumulated) {
  const t = usageTokens(resultUsage);
  return tokenTotal(t) > 0 ? t : accumulated;
}
