// Stop + PostToolUse + PreToolUse(AskUserQuestion) hook for a session holding a
// Slack claim: mirrors the turn's assistant text to the channel and posts a tool
// status line or the pending question. It never blocks a Stop: the waiter belongs
// to the asyncRewake hook (rewake-hook.mjs), not the model. A question is denied
// rather than opened as a terminal dialog, which nothing in Slack can answer. Any
// error allows — a broken hook must never wedge a session.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getPaths } from "../paths.mjs";
import { loadConfig } from "../config.mjs";
import { createBrokerClient } from "./broker-client.mjs";
import { readTranscriptFrom, textAfter, textOf, readCursor, writeCursor, tryLock } from "./transcript-tail.mjs";

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
const ARG_MAX = 80;
const ARG_KEYS = ["command", "file_path", "notebook_path", "pattern", "path", "url", "query", "skill", "description", "prompt"];

export function shortArg(input) {
  if (!input || typeof input !== "object") return "";
  const key = ARG_KEYS.find((k) => typeof input[k] === "string" && input[k].trim());
  const raw = key ? input[key] : "";
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > ARG_MAX ? flat.slice(0, ARG_MAX - 1) + "…" : flat;
}

export function readSessionFile(stateDir, sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return null;
  const file = join(stateDir, "remote-sessions", `${sessionId}.json`);
  if (!existsSync(file)) return null;
  return { ...JSON.parse(readFileSync(file, "utf8")), seizeMark: statSync(file).mtimeMs };
}

// The seize mark (remote-sessions file mtime) resets the cursor on a re-seize,
// so text written while unclaimed is never backfilled. A contender that can't
// take the lock sends nothing: its text stays after the un-advanced cursor.
// Without a usable offset (none yet, or the transcript was rewritten) one
// whole-file read locates the cursor by uuid.
async function mirror({ stateDir, sessionId, transcriptPath, session, client }) {
  const cursorFile = join(stateDir, "mirror", `${sessionId}.json`);
  const release = tryLock(cursorFile + ".lock");
  if (!release) return;
  try {
    const cursor = readCursor(cursorFile);
    const resume = cursor?.seizeMark === session.seizeMark ? cursor : null;
    const fromUuid = resume?.uuid ?? null;
    const tail = fromUuid && Number.isInteger(resume.offset) ? readTranscriptFrom(transcriptPath, resume.offset) : null;
    const read = tail ?? readTranscriptFrom(transcriptPath, 0);
    const { text, lastUuid } = tail ? textOf(read.entries, fromUuid) : textAfter(read.entries, fromUuid);
    if (text) await client.sendMessage(session.peerId, "slack-bridge", text);
    if (lastUuid && (lastUuid !== fromUuid || read.end !== resume?.offset)) {
      writeCursor(cursorFile, { uuid: lastUuid, seizeMark: session.seizeMark, offset: read.end });
    }
  } finally {
    release();
  }
}

// The terminal dialog can't be answered from Slack, but the operator must see
// what it is asking — the PostToolUse line alone is a bare tool name.
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

export async function runHook({
  raw,
  stateDir = getPaths().stateDir,
  _loadConfig = loadConfig,
  _createClient = createBrokerClient,
}) {
  let input, session;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  const event = input?.hook_event_name;
  const isQuestion = event === "PreToolUse" && input?.tool_name === "AskUserQuestion";
  if (event !== "Stop" && event !== "PostToolUse" && !isQuestion) return null;
  // Absent file = no claim held: exit before any config load or broker call,
  // which is what keeps PostToolUse cheap on unclaimed sessions.
  try {
    session = readSessionFile(stateDir, input.session_id);
  } catch {
    return null;
  }
  if (!session) return null;

  try {
    const config = _loadConfig({ configPath: session.configPath });
    const client = _createClient({
      port: config.remote?.brokerPort ?? 7898,
      token: config.remote?.controlToken ?? null,
      configPath: session.configPath,
    });

    // Mirror first, on every event and on every stop — a retried stop included,
    // which must not drop that turn's text. A mirror failure must not cost the
    // question deny or the status line.
    try {
      await mirror({ stateDir, sessionId: input.session_id, transcriptPath: input.transcript_path, session, client });
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

    if (event === "PostToolUse") {
      const arg = shortArg(input.tool_input);
      await client.sendMessage(session.peerId, "slack-bridge", arg ? `${input.tool_name}: ${arg}` : String(input.tool_name), { kind: "status" });
      return null;
    }

    // Stop ends after the mirror: the asyncRewake hook starts the next waiter.
    return null;
  } catch {
    // Every other error allows, but a claimed session must never be left on an
    // unanswerable dialog: fall back to the deny when the path was a question.
    return isQuestion ? DENY_DIALOG : null;
  }
}
