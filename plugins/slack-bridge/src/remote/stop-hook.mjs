// Stop + PostToolUse + PreToolUse(AskUserQuestion) hook for a session holding a
// Slack claim: mirrors the turn's assistant text to the channel, posts a tool
// status line or the pending question, and on Stop blocks once when no waiter is armed. Any error allows — a broken hook must
// never wedge a session.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getPaths } from "../paths.mjs";
import { loadConfig } from "../config.mjs";
import { createBrokerClient } from "./broker-client.mjs";
import { waitCommand, BASH_TIMEOUT_MS } from "./wait-constants.mjs";
import { readTranscript, textAfter, readCursor, writeCursor, tryLock } from "./transcript-tail.mjs";

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
const RECHECK_MS = 500;
const RECHECKS = 6; // 3 s: covers a waiter still booting when the turn ends
const ARG_MAX = 80;
const ARG_KEYS = ["command", "file_path", "notebook_path", "pattern", "path", "url", "query", "skill", "description", "prompt"];

export function shortArg(input) {
  if (!input || typeof input !== "object") return "";
  const key = ARG_KEYS.find((k) => typeof input[k] === "string" && input[k].trim());
  const raw = key ? input[key] : "";
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > ARG_MAX ? flat.slice(0, ARG_MAX - 1) + "…" : flat;
}

function readSessionFile(stateDir, sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return null;
  const file = join(stateDir, "remote-sessions", `${sessionId}.json`);
  if (!existsSync(file)) return null;
  return { ...JSON.parse(readFileSync(file, "utf8")), seizeMark: statSync(file).mtimeMs };
}

// The seize mark (remote-sessions file mtime) resets the cursor on a re-seize,
// so text written while unclaimed is never backfilled. A contender that can't
// take the lock sends nothing: its text stays after the un-advanced cursor.
async function mirror({ stateDir, sessionId, transcriptPath, session, client }) {
  const cursorFile = join(stateDir, "mirror", `${sessionId}.json`);
  const release = tryLock(cursorFile + ".lock");
  if (!release) return;
  try {
    const cursor = readCursor(cursorFile);
    const fromUuid = cursor?.seizeMark === session.seizeMark ? cursor.uuid : null;
    const { text, lastUuid } = textAfter(readTranscript(transcriptPath), fromUuid);
    if (text) await client.sendMessage(session.peerId, "slack-bridge", text);
    if (lastUuid && lastUuid !== fromUuid) writeCursor(cursorFile, { uuid: lastUuid, seizeMark: session.seizeMark });
  } finally {
    release();
  }
}

async function isArmed(client, peerId, _sleep) {
  for (let i = 0; ; i++) {
    const row = (await client.listPeers()).find((p) => p.id === peerId);
    // No row: the peer was reaped, so its claim is dead and the command would name a stale id.
    if (!row || row.armed) return true;
    if (i === RECHECKS) return false;
    await _sleep(RECHECK_MS);
  }
}

// The terminal dialog can't be answered from Slack, but the operator must see
// what it is asking — the PostToolUse line alone is a bare tool name.
export function formatQuestion(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  return qs.map((q) => {
    const opts = (Array.isArray(q?.options) ? q.options : [])
      .map((o) => `• *${o?.label ?? ""}*${o?.description ? ` — ${o.description}` : ""}`);
    return [`❓ ${q?.question ?? ""}`, ...opts].join("\n");
  }).join("\n\n");
}

export async function runHook({
  raw,
  stateDir = getPaths().stateDir,
  _loadConfig = loadConfig,
  _createClient = createBrokerClient,
  _sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  try {
    const input = JSON.parse(raw);
    const event = input.hook_event_name;
    const isQuestion = event === "PreToolUse" && input.tool_name === "AskUserQuestion";
    if (event !== "Stop" && event !== "PostToolUse" && !isQuestion) return null;
    // Absent file = no claim held: exit before any config load or broker call,
    // which is what keeps PostToolUse cheap on unclaimed sessions.
    const session = readSessionFile(stateDir, input.session_id);
    if (!session) return null;
    const config = _loadConfig({ configPath: session.configPath });
    const client = _createClient({
      port: config.remote?.brokerPort ?? 7898,
      token: config.remote?.controlToken ?? null,
      configPath: session.configPath,
    });

    // Mirror first, on every event — including a retried stop (stop_hook_active),
    // which must not drop that turn's text. A mirror failure must not cost the nudge.
    try {
      await mirror({ stateDir, sessionId: input.session_id, transcriptPath: input.transcript_path, session, client });
    } catch {}

    if (isQuestion) {
      const text = formatQuestion(input.tool_input);
      if (text) await client.sendMessage(session.peerId, "slack-bridge", text, { kind: "question" });
      return null;
    }

    if (event === "PostToolUse") {
      const arg = shortArg(input.tool_input);
      await client.sendMessage(session.peerId, "slack-bridge", arg ? `${input.tool_name}: ${arg}` : String(input.tool_name), { kind: "status" });
      return null;
    }

    if (input.stop_hook_active) return null;
    if (await isArmed(client, session.peerId, _sleep)) return null;
    const channel = String(session.channel ?? "").replace(/^#/, "");
    const cmd = waitCommand(session.peerId, { configPath: session.configPath });
    return {
      decision: "block",
      reason: `Slack channel #${channel} is claimed but no waiter is armed. Run: ${cmd} (run_in_background, timeout ${BASH_TIMEOUT_MS}).`,
    };
  } catch {
    return null;
  }
}
