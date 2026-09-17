// Forked from plugins/claude-peers/src/mcp/server.mjs: registers with the internal
// broker, surfaces slack_seize/release/post (via the daemon's token-guarded control
// endpoint), and delivers inbound push-or-poll — a session without the --channels
// allowlist is told to poll, so Slack messages are never silently dropped.
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRpcEndpoint } from "./jsonrpc.mjs";
import { createBrokerClient } from "../remote/broker-client.mjs";
import { detectChannelsEnabled } from "./session-flags.mjs";

const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS = `You are connected to the slack-bridge remote-control channel. The operator can DM a seized Slack channel from a mobile device and the message arrives here as a <channel source="slack-bridge"> block.

IMPORTANT: When you receive a <channel source="slack-bridge" ...> message, it is a Slack message from the operator. Reply using the slack_post tool (or send_message with to_id "slack-bridge") so your reply posts back to the Slack channel the operator is reading.

Available tools:
- slack_seize: Seize a Slack channel for remote control. With no channel arg the daemon creates a #rc-<name> channel. The name is chosen in this order: the session name the operator set in Claude Code (the chat's custom title, read automatically where the harness records one), then the 'name' arg you pass (a slug derived from the current task context for when the chat isn't named), then the auto ai-title as a last resort. Requires channels:write/manage scopes, else seizes an existing DM. Returns the channel name to report to the operator.
- slack_release: Release the seized channel.
- slack_post: Post a message to the seized Slack channel (your reply to the operator).
- send_message: Send a message to another peer by id. With to_id "slack-bridge" it posts to the seized Slack channel (passthrough).
- check_messages: Manually poll for inbound Slack messages (fallback).`;

// Appended only when the push path cannot reach this session. Concrete tool calls,
// not prose: the weakest model that reads this must get a working cron in one pass.
export const POLLING_INSTRUCTIONS = `MESSAGE DELIVERY IN THIS SESSION: push is UNAVAILABLE. This session was not launched with \`--dangerously-load-development-channels plugin:slack-bridge\`, so a <channel source="slack-bridge"> block will never render for you. Ignore the paragraph above about channel messages — you must poll instead, or you will never see the operator's Slack messages.

Set up the poll now, before your other startup work:

1. If the CronCreate tool's schema is not loaded, load it first: ToolSearch(query="select:CronCreate")
2. CronCreate(cron="*/3 * * * *", prompt="Call check_messages. If it returns messages, reply to each with slack_post, then resume what you were doing.", recurring=true)

That checks every 3 minutes. The job lives only in this session and expires after 7 days — create it again in your next session. Between ticks, call check_messages directly whenever you are waiting on the operator's reply.`;

export function buildInstructions(channelsAvailable) {
  return channelsAvailable ? INSTRUCTIONS : `${INSTRUCTIONS}\n\n${POLLING_INSTRUCTIONS}`;
}

export const TOOLS = [
  {
    name: "slack_seize",
    description: "Seize a Slack channel for remote control. With no channel, the daemon creates a #rc-<name> channel. The name is chosen in this order: (1) the session name the operator set in Claude Code (the chat's custom title — read automatically where the harness records one), (2) the 'name' arg you pass, a slug derived from the current task context (branch/plan/feature) for when the operator hasn't named the chat, (3) the auto ai-title as a last resort. Requires channels:write/manage scopes, else seizes an existing DM with the bot. Returns the channel name to report to the operator.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Optional existing channel id to seize (join) instead of creating one." },
        name: { type: "string", description: "A short slug derived from the current task context (git branch, plan slug, or feature name) for when the operator hasn't named the chat. The operator-set custom title takes priority over this where the harness records one. If omitted and there is no custom title, the auto ai-title is used as a last resort." },
      },
    },
  },
  {
    name: "slack_release",
    description: "Release the seized Slack channel. The next Slack message on it falls back to a fresh claude -p spawn.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "slack_post",
    description: "Post a message to the seized Slack channel. Use this to reply to the operator from the live session.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "The message to post to Slack." } },
      required: ["message"],
    },
  },
  {
    name: "send_message",
    description: "Send a message to another peer by id. With to_id \"slack-bridge\" it posts to the seized Slack channel (passthrough).",
    inputSchema: {
      type: "object",
      properties: {
        to_id: { type: "string", description: "The target peer id (use \"slack-bridge\" to post to Slack)." },
        message: { type: "string", description: "The message to send." },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "check_messages",
    description: "Retrieve inbound Slack messages held by the broker — including ones already pushed as a notification that may not have rendered, so a push missed while your session was idle is not lost. May re-show a message you already saw.",
    inputSchema: { type: "object", properties: {} },
  },
];

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const errText = (prefix, e) => text(`${prefix}: ${e instanceof Error ? e.message : String(e)}`, true);

// Encode a cwd into the segment Claude Code uses for its per-project session dir
// (e.g. `C:\code\long-night` → `C--code-long-night`): backslash, forward slash,
// colon, and dot all rewritten to `-`. Matches `~/.claude/projects/<encoded-cwd>/`.
export function encodeCwd(cwd) {
  return String(cwd).replace(/[\\/.:]/g, "-");
}

// Scan the most-recently-modified session JSONL in this project's session dir for
// the latest record of `recordType` and return its `field` value (newest match wins).
// "Most-recently-modified" is a heuristic for "the current session" — wrong only when
// two sessions share a project dir, and a miss falls through to the next name source.
// `projectsDir` is injectable for tests (defaults to `~/.claude/projects`).
function readLatestSessionField(cwd, recordType, field, { projectsDir } = {}) {
  try {
    const dir = (projectsDir ?? path.join(os.homedir(), ".claude", "projects")) + "";
    const projDir = path.join(dir, encodeCwd(cwd));
    if (!fs.existsSync(projDir)) return null;
    const entries = fs.readdirSync(projDir).filter((f) => f.endsWith(".jsonl"));
    if (entries.length === 0) return null;
    let latest = null;
    let latestM = -1;
    for (const f of entries) {
      const st = fs.statSync(path.join(projDir, f));
      if (st.mtimeMs > latestM) {
        latestM = st.mtimeMs;
        latest = f;
      }
    }
    if (!latest) return null;
    const fp = path.join(projDir, latest);
    const size = fs.statSync(fp).size;
    // Forward chunk scan with a line carry: the record can sit anywhere in the
    // file (a title set hours ago on a transcript that has grown since), so a
    // fixed tail read would miss it; chunking keeps memory bounded.
    const CHUNK = 1_000_000;
    const fd = fs.openSync(fp, "r");
    let value = null;
    try {
      let pos = 0;
      let carry = "";
      const checkLine = (line) => {
        if (!line.includes(recordType)) return;
        try {
          const o = JSON.parse(line);
          if (o && o.type === recordType && o[field]) value = o[field];
        } catch {
          /* corrupt line or a utf8 char split at the chunk boundary — skip */
        }
      };
      while (pos < size) {
        const len = Math.min(CHUNK, size - pos);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, pos);
        pos += len;
        const lines = (carry + buf.toString("utf8")).split("\n");
        carry = lines.pop() ?? ""; // partial tail line — rejoined with the next chunk
        for (const line of lines) checkLine(line);
      }
      if (carry) checkLine(carry);
    } finally {
      fs.closeSync(fd);
    }
    return value;
  } catch {
    return null;
  }
}

// The operator-named chat name, read from a `custom-title` session record (best-effort:
// that record shape is not observed on every harness, and a missing one falls through
// cleanly to the session-derived name). Returns null when the chat was never named.
export function readSessionName(cwd, opts) {
  return readLatestSessionField(cwd, "custom-title", "customTitle", opts);
}

// CC's auto-generated `ai-title` — a first-message-derived summary, so a
// last-resort label, never a chosen name.
export function readSessionAiTitle(cwd, opts) {
  return readLatestSessionField(cwd, "ai-title", "aiTitle", opts);
}

export function createRemoteMcpServer({
  config,
  configPath = null,
  log = () => {},
  input = process.stdin,
  output = process.stdout,
  _fetch = fetch,
  _spawn = spawn,
  _execFile = execFile,
  _pid = process.pid,
  _cwd = process.cwd(),
  _setInterval = setInterval,
  _detectChannels = detectChannelsEnabled,
} = {}) {
  const brokerPort = config.remote?.brokerPort ?? 7898;
  const controlPort = config.remote?.controlPort ?? 7897;
  const controlToken = config.remote?.controlToken ?? null;
  const controlUrl = `http://127.0.0.1:${controlPort}`;
  const broker = createBrokerClient({ port: brokerPort, token: controlToken, configPath, log, _fetch, _spawn });

  let myId = null;
  let myGitRoot = null;
  let channelsAvailable; // memoised: reading the process table is not free

  async function controlFetch(path, body) {
    const res = await _fetch(`${controlUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${controlToken}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `control ${path}: ${res.status}`);
    return json;
  }

  function getGitRoot(cwd) {
    return new Promise((resolve) => {
      _execFile("git", ["rev-parse", "--show-toplevel"], { cwd }, (err, stdout) => {
        resolve(err ? null : stdout.trim());
      });
    });
  }

  async function register() {
    myGitRoot = await getGitRoot(_cwd);
    const reg = await broker.register({ pid: _pid, cwd: _cwd, git_root: myGitRoot, tty: null, summary: "slack-bridge remote" });
    myId = reg.id;
    log(`registered as peer ${myId}`);
  }

  const toolHandlers = {
    async slack_seize(args) {
      if (!myId) return text("Not registered with broker yet", true);
      try {
        // Name precedence: operator custom-title (best-effort read from the session
        // JSONL) → the session-derived `name` arg → auto ai-title → daemon peer-id
        // fragment. Never the cwd basename — a project-dir channel name means broke.
        const name = readSessionName(_cwd) || args.name || readSessionAiTitle(_cwd) || null;
        const r = await controlFetch("/claim", { peer_id: myId, channel: args.channel ?? null, name });
        const label = r.is_dm ? "your DM with the bot" : r.channel_name ? `#${r.channel_name}` : r.channel;
        return text(`📱 Slack remote ready: ${label}${r.topic ? ` — ${r.topic}` : ""}. DM it from a second device; inbound messages arrive here as a <channel source=\"slack-bridge\"> block. Reply with slack_post.`);
      } catch (e) {
        return errText("Seize failed", e);
      }
    },
    async slack_release() {
      if (!myId) return text("Not registered with broker yet", true);
      try {
        await controlFetch("/release", { peer_id: myId });
        return text("Released the Slack channel. The next Slack message falls back to a fresh claude -p spawn.");
      } catch (e) {
        return errText("Release failed", e);
      }
    },
    async slack_post(args) {
      if (!myId) return text("Not registered with broker yet", true);
      try {
        // Route the reply through the broker (to_id "slack-bridge") so the daemon's
        // reply-poll picks it up and updates the "routed to live session" placeholder
        // in place — matching the integration-test contract. A direct control /post
        // would post out-of-band and leave the placeholder to time out.
        const result = await broker.sendMessage(myId, "slack-bridge", args.message);
        if (!result.ok) return text(`Failed to post: ${result.error}`, true);
        return text("Reply sent to Slack.");
      } catch (e) {
        return errText("Post failed", e);
      }
    },
    async send_message(args) {
      if (!myId) return text("Not registered with broker yet", true);
      try {
        // to_id "slack-bridge" is the outbound route to Slack (same path as slack_post).
        const result = await broker.sendMessage(myId, args.to_id, args.message);
        if (!result.ok) return text(`Failed to send: ${result.error}`, true);
        return text(args.to_id === "slack-bridge" ? "Reply sent to Slack." : `Message sent to peer ${args.to_id}`);
      } catch (e) {
        return errText("Error sending message", e);
      }
    },
    async check_messages() {
      if (!myId) return text("Not registered with broker yet", true);
      try {
        // Consume path: returns everything held — pushed or not — so a push
        // that never rendered (idle session, no allowlist, cloud model) is
        // still recoverable. May re-show an already-seen message.
        const result = await broker.takeMessages(myId);
        if (result.messages.length === 0) return text("No new messages.");
        const lines = result.messages.map((m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`);
        return text(`${result.messages.length} message(s):\n\n${lines.join("\n\n---\n\n")}`
          + `\n\n(Any of these may already have appeared as a channel notification — reply once.)`);
      } catch (e) {
        return errText("Error checking messages", e);
      }
    },
  };

  async function onRequest(method, params) {
    if (method === "initialize") {
      // Dormant (no remote.controlToken): honest empty state — no tools, no
      // reply instructions. The session gets a clean "off" instead of a
      // half-configured server it cannot use.
      if (!controlToken) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "slack-bridge-remote", version: SERVER_VERSION },
          instructions: "slack-bridge remote control is not configured (no remote.controlToken in config.json). Nothing to do here — run claude-slack setup to enable it.",
        };
      }
      channelsAvailable ??= _detectChannels();
      if (!channelsAvailable) log("channels unavailable — instructing this session to poll");
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { experimental: { "claude/channel": {} }, tools: {} },
        serverInfo: { name: "slack-bridge-remote", version: SERVER_VERSION },
        instructions: buildInstructions(channelsAvailable),
      };
    }
    if (method === "tools/list") return { tools: controlToken ? TOOLS : [] };
    if (method === "tools/call") {
      if (!controlToken) throw new Error("Remote control is not configured (no remote.controlToken in config.json)");
      const handler = toolHandlers[params.name];
      if (!handler) {
        const e = new Error(`Unknown tool: ${params.name}`);
        e.rpcCode = -32602;
        throw e;
      }
      return handler(params.arguments ?? {});
    }
    if (method === "ping") return {};
    const e = new Error(`Method not found: ${method}`);
    e.rpcCode = -32601;
    throw e;
  }

  const rpc = createRpcEndpoint({ input, output, onRequest, log });

  async function poll() {
    if (!myId) return;
    try {
      const messages = await broker.pollMessages(myId);
      for (const msg of messages) {
        rpc.notify("notifications/claude/channel", {
          content: msg.text,
          meta: { from_id: msg.from_id, from_summary: "", from_cwd: "", sent_at: msg.sent_at },
        });
        log(`pushed slack message from ${msg.from_id}`);
      }
    } catch (e) {
      log(`poll error: ${e.message}`);
    }
  }

  async function heartbeat() {
    if (!myId) return;
    try { await broker.heartbeat(myId); } catch { /* self-heals on next poll */ }
  }

  async function start() {
    // CONFIG.md: remote control is off unless remote.controlToken is set. Dormant
    // means dormant — no broker spawn, no poll/heartbeat timers, no registration.
    if (!controlToken) {
      log("remote control disabled — no remote.controlToken; server dormant");
      return;
    }
    await broker.ensureBroker();
    await register();
    const pollTimer = _setInterval(poll, config.remote.pollIntervalMs);
    pollTimer.unref?.();
    const hbTimer = _setInterval(heartbeat, config.remote.heartbeatIntervalMs);
    hbTimer.unref?.();
    log("MCP endpoint ready");
  }

  return { start, _onRequest: onRequest, _register: register, _poll: poll, _brokerFetch: broker.brokerFetch, _ensureBroker: broker.ensureBroker, _controlFetch: controlFetch, _myId: () => myId };
}
