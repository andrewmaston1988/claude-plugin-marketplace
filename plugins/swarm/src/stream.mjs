// Incremental parser for `claude -p --output-format stream-json` stdout, plus
// token bookkeeping. The engine feeds raw chunks as they arrive; anything that
// is not a recognised JSONL event is silently ignored, so a provider (or an
// old CLI) that emits plain text degrades to zero events — the caller's raw
// buffer remains the source of truth for output in that case.

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

// Headline count: work tokens (input + output + cache writes). Cache reads are
// re-served prefix, kept in the breakdown but excluded from the headline.
export function tokenTotal(t) {
  return t ? t.input + t.output + t.cacheCreation : 0;
}

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
  return tokenTotal(t) + t.cacheRead > 0 ? t : accumulated;
}

// Line-oriented incremental parser. feed() buffers partial lines across chunk
// boundaries; end() flushes a trailing unterminated line.
export function createStreamParser({ onUsage, onResult } = {}) {
  let buf = "";
  const handleLine = (line) => {
    const t = line.trim();
    if (!t.startsWith("{")) return;
    let evt;
    try {
      evt = JSON.parse(t);
    } catch {
      return; // not an event line — plain output or torn write
    }
    if (evt.type === "assistant" && evt.message?.usage) onUsage?.(evt.message.id || "?", evt.message.usage);
    else if (evt.type === "result") onResult?.(evt);
  };
  return {
    feed(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    },
    end() {
      if (buf) handleLine(buf);
      buf = "";
    },
  };
}
