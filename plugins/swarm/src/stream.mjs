import { runnerEvent } from "./contracts.mjs";

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

// One tool_use block -> a short human line for the roster's activity cell.
// Argument preference: the most locating field first; nothing scalar -> bare name.
const ARG_KEYS = ["file_path", "path", "url", "command", "pattern", "query"];

export function describeToolUse(block) {
  const input = block.input || {};
  for (const k of ARG_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v) {
      const arg = v.length > 40 ? v.slice(0, 39) + "…" : v;
      return `${block.name} ${arg}`;
    }
  }
  return String(block.name);
}

// Line-oriented incremental parser. feed() buffers partial lines across chunk
// boundaries; end() flushes a trailing unterminated line.
export function createStreamParser({ onUsage, onResult, onActivity, onInit, onStop } = {}) {
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
    if (evt.type === "system" && evt.subtype === "init") {
      onInit?.(evt);
    } else if (evt.type === "assistant") {
      if (evt.message?.usage) onUsage?.(evt.message.id || "?", evt.message.usage);
      // stop_reason lives on the assistant message; a clean completion ends on
      // "end_turn". A leaf cut mid-stream ends on null/tool_use/absent — the
      // signal the engine needs to catch a false-green (exit 0 but never finished).
      onStop?.(evt.message?.stop_reason);
      for (const block of evt.message?.content || []) {
        if (block?.type === "tool_use" && block.name) onActivity?.(describeToolUse(block));
      }
    } else if (evt.type === "result") onResult?.(evt);
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

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function codexUsage(usage) {
  const source = usage && typeof usage === "object" ? usage : {};
  return {
    input: numberOrZero(source.input_tokens ?? source.inputTokens ?? source.input),
    output: numberOrZero(source.output_tokens ?? source.outputTokens ?? source.output),
    cacheCreation: numberOrZero(source.cache_creation_input_tokens ?? source.cacheCreation),
    cacheRead: numberOrZero(source.cached_input_tokens ?? source.cache_read_input_tokens ?? source.cacheRead),
  };
}

function hasUsage(usage) {
  return Object.values(usage).some((value) => value > 0);
}

function textFromValue(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.delta === "string") return value.delta;
  if (typeof value.content === "string") return value.content;
  if (typeof value.output_text === "string") return value.output_text;
  if (typeof value.outputText === "string") return value.outputText;
  if (Array.isArray(value.content)) return value.content.map(textFromValue).join("");
  if (Array.isArray(value.parts)) return value.parts.map(textFromValue).join("");
  return "";
}

function itemText(item) {
  if (!item || typeof item !== "object") return "";
  return textFromValue(item.text) || textFromValue(item.content) || textFromValue(item.message) || textFromValue(item.output_text);
}

function sessionFrom(event) {
  return event.thread_id || event.threadId || event.session_id || event.sessionId || event.thread?.id || event.session?.id;
}

function modelFrom(event) {
  return event.model || event.real_model || event.realModel || event.turn?.model;
}

function errorFrom(event) {
  const value = event.error || event.reason || event.message || event;
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "Codex runner failed";
  return value.message || value.code || "Codex runner failed";
}

function activityFrom(item) {
  if (!item || typeof item !== "object") return null;
  const kind = item.type || item.kind || item.item_type;
  if (!kind || /message|text/i.test(kind)) return null;
  const activity = { kind: "tool", type: kind };
  if (item.id) activity.id = String(item.id);
  if (item.command) activity.command = String(item.command);
  if (item.name) activity.name = String(item.name);
  if (item.status) activity.status = String(item.status);
  return activity;
}

// Codex emits interim agent messages before its answer; the last message is the leaf's output.
function finalMessage(outputById) {
  return [...outputById.values()].at(-1) || "";
}

function isMessageItem(item) {
  const kind = item.type || item.kind || item.item_type;
  return !kind || /message/i.test(kind);
}

function appendText(outputById, id, text) {
  if (!text) return { emitted: "", output: finalMessage(outputById) };
  const key = id || `item-${outputById.size}`;
  const previous = outputById.get(key) || "";
  outputById.set(key, text);
  const emitted = text.startsWith(previous) ? text.slice(previous.length) : text;
  return { emitted, output: finalMessage(outputById) };
}

function canonicalEvent(value, emit) {
  const event = runnerEvent(value);
  emit?.(event);
  return event;
}

// Normalizes Codex app-server JSONL into the runner contract. The parser only
// exposes canonical events; callers never need to depend on protocol fields.
export function createCodexStreamParser({ emit: emitCallback, onEvent, onSession, onText, onUsage, onActivity, onComplete, onError } = {}) {
  const send = (event) => {
    const canonical = canonicalEvent(event, emitCallback || onEvent);
    if (canonical.type === "session") onSession?.(canonical);
    else if (canonical.type === "text") onText?.(canonical);
    else if (canonical.type === "usage") onUsage?.(canonical);
    else if (canonical.type === "activity") onActivity?.(canonical);
    else if (canonical.type === "completed") onComplete?.(canonical);
    else if (canonical.type === "error") onError?.(canonical);
    return canonical;
  };

  let buf = "";
  let terminal = false;
  let ended = false;
  let sessionId;
  let realModel;
  let usage = emptyTokens();
  let error;
  const outputById = new Map();
  const events = [];

  const emit = (event) => {
    const canonical = send(event);
    events.push(canonical);
    return canonical;
  };

  const recordUsage = (value) => {
    const next = codexUsage(value);
    if (!hasUsage(next)) return;
    usage = next;
    emit({ type: "usage", ...(sessionId ? { sessionId } : {}), usage });
  };

  const emitText = (value, id, { delta = false } = {}) => {
    const text = textFromValue(value);
    const key = id || `item-${outputById.size}`;
    const previous = outputById.get(key) || "";
    const result = delta
      ? appendText(outputById, key, previous + text)
      : appendText(outputById, key, text);
    if (result.emitted) emit({ type: "text", ...(sessionId ? { sessionId } : {}), text: result.emitted });
    return result;
  };

  const finish = (value = {}) => {
    if (terminal) return;
    const priorOutput = finalMessage(outputById);
    const finalText = textFromValue(value.output);
    if (finalText && !priorOutput) outputById.set("__final__", finalText);
    if (value.error) error = value.error;
    terminal = true;
    emit({
      type: value.error ? "error" : "completed",
      ...(sessionId ? { sessionId } : {}),
      ...(realModel ? { realModel } : {}),
      ...(hasUsage(usage) ? { usage } : {}),
      terminal: true,
      ...(value.error ? { error: value.error } : {}),
      ...(finalText && !priorOutput ? { text: finalText } : {}),
    });
  };

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;

    const nextSession = sessionFrom(event);
    if (nextSession && !sessionId) {
      sessionId = String(nextSession);
      emit({ type: "session", sessionId });
    }
    const nextModel = modelFrom(event);
    if (nextModel) realModel = String(nextModel);

    const type = String(event.type || event.event || "");
    if (type === "thread.started" || type === "thread.created") return;

    if (type === "response.output_text.delta" || type === "output_text.delta" || type === "text.delta") {
      emitText(event.delta ?? event.text ?? event.output_text, event.item_id || event.itemId || event.id, { delta: true });
      return;
    }

    if (type === "item.started" || type === "item.updated" || type === "item.completed") {
      const item = event.item || event.data || event;
      const id = item.id || event.item_id || event.itemId;
      const activity = activityFrom(item);
      if (activity) emit({ type: "activity", ...(sessionId ? { sessionId } : {}), activity });
      const text = isMessageItem(item) ? itemText(item) : "";
      if (text) emitText(text, id);
      if (item.usage || event.usage) recordUsage(item.usage || event.usage);
      return;
    }

    if (type === "turn.started" || type === "turn.updated") {
      if (event.usage || event.turn?.usage) recordUsage(event.usage || event.turn.usage);
      return;
    }

    if (type === "turn.completed" || type === "response.completed") {
      recordUsage(event.usage || event.turn?.usage || event.response?.usage);
      finish({ output: textFromValue(event.output_text || event.output) });
      return;
    }

    if (type === "turn.failed" || type === "response.failed" || type === "error" || event.error) {
      error = errorFrom(event);
      finish({ error });
    }
  };

  return {
    feed(chunk) {
      if (ended) return;
      buf += String(chunk ?? "");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    },
    end() {
      if (ended) return this;
      if (buf) handleLine(buf);
      buf = "";
      ended = true;
      if (!terminal) finish({ error: { code: "missing_terminal", message: "Codex stream ended without a terminal event" } });
      return this;
    },
    events() {
      return [...events];
    },
    result() {
      return {
        ...(sessionId ? { sessionId } : {}),
        ...(realModel ? { realModel } : {}),
        output: finalMessage(outputById),
        usage,
        terminal,
        ...(error ? { error } : {}),
      };
    },
  };
}

// A contract-facing Claude parser. The legacy parser above remains available
// to the scheduler; this wrapper lets the runner registry expose one shape for
// both providers without changing scheduler behavior.
export function createClaudeRunnerParser(options = {}) {
  let terminal = false;
  let sessionId;
  let realModel;
  let usage = emptyTokens();
  const acc = createUsageAccumulator();
  let output = "";
  let stopReason;
  let costUsd;
  let numTurns;
  let apiKeySource;
  let error;
  const emit = options.emit || options.onEvent;
  const send = (event) => {
    const canonical = runnerEvent(event);
    emit?.(canonical);
    return canonical;
  };
  const parser = createStreamParser({
    onInit(event) {
      sessionId = event.session_id || event.sessionId;
      if (sessionId) send({ type: "session", sessionId: String(sessionId) });
      if (event.model) realModel = String(event.model);
      if (event.apiKeySource != null) apiKeySource = event.apiKeySource;
    },
    onStop(reason) {
      if (reason) stopReason = reason;
    },
    onUsage(id, value) {
      // Latest usage per message id, never a running sum: stream-json re-emits an
      // assistant message as its content blocks complete.
      acc.record(id, value);
      usage = acc.totals();
      send({ type: "usage", ...(sessionId ? { sessionId: String(sessionId) } : {}), usage });
    },
    onActivity(activity) {
      send({ type: "activity", ...(sessionId ? { sessionId: String(sessionId) } : {}), activity: { kind: "tool", label: activity } });
    },
    onResult(result) {
      output = typeof result.result === "string" ? result.result : output;
      if (result.is_error === true || result.subtype === "error") {
        error = {
          code: result.error?.code || result.error_code || "runner_error",
          message: typeof result.result === "string" ? result.result : "Claude runner failed",
        };
        terminal = true;
        send({
          type: "error",
          ...(sessionId ? { sessionId: String(sessionId) } : {}),
          terminal: true,
          error,
        });
        return;
      }
      const finalUsage = pickFinalTokens(result.usage, usage);
      usage = finalUsage;
      if (result.total_cost_usd != null) costUsd = result.total_cost_usd;
      if (result.num_turns != null) numTurns = result.num_turns;
      if (result.apiKeySource != null) apiKeySource = result.apiKeySource;
      terminal = true;
      send({
        type: "completed",
        ...(sessionId ? { sessionId: String(sessionId) } : {}),
        ...(realModel ? { realModel } : {}),
        usage,
        terminal: true,
      });
    },
  });
  return {
    feed(chunk) {
      parser.feed(chunk);
    },
    end() {
      parser.end();
      if (!terminal) {
        terminal = true;
        send({ type: "error", ...(sessionId ? { sessionId: String(sessionId) } : {}), terminal: true, error: { code: "missing_terminal", message: "Claude stream ended without a terminal result" } });
      }
      return this;
    },
    result() {
      return {
        ...(sessionId ? { sessionId: String(sessionId) } : {}),
        ...(realModel ? { realModel } : {}),
        output, usage, terminal,
        ...(stopReason ? { stopReason } : {}),
        ...(costUsd != null ? { costUsd } : {}),
        ...(numTurns != null ? { numTurns } : {}),
        ...(apiKeySource != null ? { apiKeySource } : {}),
        ...(error ? { error } : {}),
      };
    },
  };
}

export const runnerParserFactories = new Map();

export function registerRunnerParser(runner, factory) {
  if (typeof runner !== "string" || !runner.trim()) throw new Error("runner must be a non-empty string");
  if (typeof factory !== "function") throw new Error(`parser factory for ${runner} must be a function`);
  runnerParserFactories.set(runner.trim().toLowerCase(), factory);
  return factory;
}

export function createRunnerParser(runner, options = {}) {
  const factory = runnerParserFactories.get(String(runner || "").trim().toLowerCase());
  if (!factory) throw new Error(`No stream parser registered for runner '${runner}'`);
  return factory(options);
}

registerRunnerParser("claude", createClaudeRunnerParser);
registerRunnerParser("codex", createCodexStreamParser);
