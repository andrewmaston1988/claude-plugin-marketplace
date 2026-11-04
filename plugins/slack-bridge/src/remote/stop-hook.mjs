// The hook for a session holding a Slack claim: mirrors assistant text, posts a status
// as a tool starts, and denies a question nothing in Slack could answer. It never
// blocks a Stop, and any error allows: a broken hook must never wedge a session.
import { join } from "node:path";
import { getPaths } from "../paths.mjs";
import { loadConfig } from "../config.mjs";
import { createBrokerClient } from "./broker-client.mjs";
import { readTranscriptFrom, textAfter, textOf, hasToolUse, readCursor, writeCursor, tryLock } from "./transcript-tail.mjs";
import { brokerOptions, readSessionFile, writeTurnEnd } from "./session-file.mjs";
import { PRIMING_LINE } from "./waiter.mjs";
import { STOP_WAIT_MS } from "./wait-constants.mjs";

const ARG_MAX = 80;
const ARG_KEYS = ["command", "file_path", "notebook_path", "pattern", "path", "url", "query", "skill", "description", "prompt"];
// At Stop the CLI has not flushed the turn's last entry yet, so the hook polls
// the mirror until the reply shows up. The cursor keeps the last TAIL_CHARS
// characters it sent; a 64-character needle survives assistantText trimming and
// joining, which a whole-message comparison would not.
const TAIL_CHARS = 256;
const NEEDLE_CHARS = 64;
const STOP_POLL_MS = 100;
// As a tool starts, the entries before it may still be unflushed. The hook is
// async, so waiting costs the tool nothing; another pass may already have taken
// the entry, which only runs this to the bound.
const TOOL_WAIT_MS = 2_000;
const TOOL_POLL_MS = 250;

export function shortArg(input) {
  if (!input || typeof input !== "object") return "";
  const key = ARG_KEYS.find((k) => typeof input[k] === "string" && input[k].trim());
  const raw = key ? input[key] : "";
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > ARG_MAX ? flat.slice(0, ARG_MAX - 1) + "…" : flat;
}

// The seize mark resets the cursor on a re-seize, so text written while unclaimed is
// never backfilled. A pass locked out sends nothing: its text stays after the cursor.
// Returns the tail of what has been mirrored, or null when locked out.
async function mirror({ stateDir, sessionId, transcriptPath, session, client, onRead }) {
  const cursorFile = join(stateDir, "mirror", `${sessionId}.json`);
  const release = tryLock(cursorFile + ".lock");
  if (!release) return null;
  try {
    const cursor = readCursor(cursorFile);
    const resume = cursor?.seizeMark === session.seizeMark ? cursor : null;
    const fromUuid = resume?.uuid ?? null;
    const tail = fromUuid && Number.isInteger(resume.offset) ? readTranscriptFrom(transcriptPath, resume.offset) : null;
    const read = tail ?? readTranscriptFrom(transcriptPath, 0);
    onRead?.(read.entries);
    const { text, lastUuid } = tail ? textOf(read.entries, fromUuid) : textAfter(read.entries, fromUuid);
    if (text) await client.sendMessage(session.peerId, "slack-bridge", text);
    const previous = typeof resume?.tail === "string" ? resume.tail : "";
    const mirrored = (text ? previous + (previous ? "\n\n" : "") + text : previous).slice(-TAIL_CHARS);
    if (lastUuid && (lastUuid !== fromUuid || read.end !== resume?.offset || resume?.tail !== mirrored)) {
      writeCursor(cursorFile, { uuid: lastUuid, seizeMark: session.seizeMark, offset: read.end, tail: mirrored });
    }
    return mirrored;
  } finally {
    release();
  }
}

// A new turn starts clean: an identical short reply next turn must not be
// mistaken for the previous turn's text still sitting in the tail. Under the
// mirror's lock: clearing beside a mirror can rewind the cursor and double-post.
function clearTail(cursorFile) {
  const release = tryLock(cursorFile + ".lock");
  if (!release) return;
  try {
    const cursor = readCursor(cursorFile);
    if (!cursor || !("tail" in cursor)) return;
    delete cursor.tail;
    writeCursor(cursorFile, cursor);
  } finally {
    release();
  }
}

// The terminal dialog can't be answered from Slack, but the operator must see
// what it is asking — a status line alone is a bare tool name.
// Markdown, not mrkdwn: every sender runs it through mdToSlack, which also spaces the dash.
export function formatQuestion(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  return qs.map((q) => {
    const opts = (Array.isArray(q?.options) ? q.options : [])
      .map((o) => `• **${o?.label ?? ""}**${o?.description ? `—${o.description}` : ""}`);
    return [`❓ ${q?.question ?? ""}`, ...opts].join("\n");
  }).join("\n\n");
}

// A claimed session cannot answer a terminal dialog: nobody is at the keyboard,
// and the reply the operator types in Slack is never consumed. Denying the tool
// turns it into a plain-text ask, which the mirror already carries to the channel.
const DENY_DIALOG = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      "This session is under Slack remote control: a terminal dialog cannot be answered. " +
      "Ask the question in plain text, with the options, and end your turn — the text is mirrored to Slack.",
  },
};

// A wake arrives as a prompt too, so not every UserPromptSubmit is the operator
// typing. A rewake carries <task-notification>, and a Slack message carries the
// priming line — mirroring either would post the operator's own text back at them.
function isEchoedPrompt(prompt) {
  return prompt.startsWith("<task-notification>") || prompt.includes(PRIMING_LINE);
}

export async function runHook({
  raw,
  toolStart,
  stateDir = getPaths().stateDir,
  _loadConfig = loadConfig,
  _createClient = createBrokerClient,
  _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  _now = () => Date.now(),
}) {
  // Wall clock, sent with the status, prompt and turn-end: the daemon drops a status
  // whose hook started before the turn ended.
  const hookStartedAt = Date.now();
  let input, session;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  const event = input?.hook_event_name;
  // Two PreToolUse entries: the synchronous one can deny a question, and the
  // async one on every tool must leave that tool to it.
  const isAsk = input?.tool_name === "AskUserQuestion";
  const isQuestion = event === "PreToolUse" && !toolStart && isAsk;
  const isToolStart = event === "PreToolUse" && toolStart && !isAsk;
  const isPrompt = event === "UserPromptSubmit";
  const isStopFailure = event === "StopFailure";
  // The idle prompt comes about a minute after any response, if nobody has typed. After
  // Esc, which runs no hook, it is the first sign the turn is over.
  const isIdle = event === "Notification" && input?.notification_type === "idle_prompt";
  if (event !== "Stop" && event !== "PostToolUse" && !isQuestion && !isToolStart && !isPrompt && !isStopFailure && !isIdle) return null;
  // Absent file = no claim held: exit before any config load or broker call,
  // which is what keeps a tool call cheap on unclaimed sessions.
  try {
    session = readSessionFile(stateDir, input.session_id);
  } catch {
    return null;
  }
  if (!session) return null;

  try {
    const config = _loadConfig({ configPath: session.configPath });
    const client = _createClient(brokerOptions(session, config));

    // Mirror first, on every event and on every stop — a retried stop included,
    // which must not drop that turn's text. A mirror failure must not cost the
    // question deny or the status line.
    let toolSeen = false;
    const onRead = (entries) => { toolSeen ||= hasToolUse(entries, input.tool_use_id); };
    const mirrorOnce = () => mirror({ stateDir, sessionId: input.session_id, transcriptPath: input.transcript_path, session, client, onRead });
    const stopStartedAt = event === "Stop" ? _now() : 0;
    let mirrored = null;
    try {
      mirrored = await mirrorOnce();
    } catch {}

    if (isQuestion) {
      // Mirror, then deny. A failed post costs the operator sight of the question,
      // which is recoverable; a dialog nobody can answer parks the turn for good.
      try {
        const text = formatQuestion(input.tool_input);
        if (text) await client.sendMessage(session.peerId, "slack-bridge", text, { kind: "question" });
      } catch {}
      return DENY_DIALOG;
    }

    if (isPrompt) {
      const prompt = String(input.prompt ?? "").trim();
      // A wake is not the operator typing: skip it, and skip anything else that
      // came from Slack rather than the keyboard.
      if (prompt && !isEchoedPrompt(prompt)) {
        await client.sendMessage(session.peerId, "slack-bridge", prompt, { kind: "prompt", hookStartedAt });
      }
      // Wakes fire this too, so clear on every one: the tail must never outlive
      // its turn.
      clearTail(join(stateDir, "mirror", `${input.session_id}.json`));
      return null;
    }

    if (event === "PostToolUse") return null;

    // An API error ends the turn with no Stop: its message is the error, not a reply to
    // wait for. Neither it nor the idle prompt starts a waiter, so there is no marker to
    // write, and the text names why: the daemon then keeps no block for a queued message.
    if (isStopFailure || isIdle) {
      await client.sendMessage(session.peerId, "slack-bridge", isIdle ? "idle" : "stop failure", { kind: "turn-end", hookStartedAt });
      return null;
    }

    if (isToolStart) {
      // Text first, then the status: the block under it must say what is running.
      const startedAt = _now();
      while (!toolSeen && _now() - startedAt < TOOL_WAIT_MS) {
        await _sleep(TOOL_POLL_MS);
        try {
          await mirrorOnce();
        } catch {
          break; // a broken mirror must still reach the status
        }
      }
      const arg = shortArg(input.tool_input);
      await client.sendMessage(session.peerId, "slack-bridge", arg ? `${input.tool_name}: ${arg}` : String(input.tool_name), { kind: "status", hookStartedAt });
      return null;
    }

    // The turn is over: the daemon closes this peer's terminal block. Wait for
    // the turn's last transcript entry, which the CLI flushes after this hook
    // starts, then close. Posting the field itself would double-post once the
    // mirror catches up, so only the tail is compared. No field means no wait.
    const last = typeof input.last_assistant_message === "string" ? input.last_assistant_message.trim() : "";
    if (last) {
      const needle = last.slice(-NEEDLE_CHARS);
      while (mirrored === null || !mirrored.includes(needle)) {
        if (_now() - stopStartedAt >= STOP_WAIT_MS) break;
        await _sleep(STOP_POLL_MS);
        try {
          mirrored = await mirrorOnce();
        } catch {
          break; // a broken mirror must still reach turn-end
        }
      }
    }
    try {
      await client.sendMessage(session.peerId, "slack-bridge", "", { kind: "turn-end", hookStartedAt });
    } finally {
      // The waiter this Stop started holds its first take until this lands.
      writeTurnEnd(stateDir, input.session_id, _now());
    }
    return null;
  } catch {
    // Every other error allows, but a claimed session must never be left on an
    // unanswerable dialog: fall back to the deny when the path was a question.
    return isQuestion ? DENY_DIALOG : null;
  }
}
