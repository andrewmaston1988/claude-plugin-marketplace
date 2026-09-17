// Forked from plugins/claude-peers/src/mcp/server.mjs. The live interactive session
// loads this stdio MCP server (declared in the plugin manifest, mirroring
// claude-peers; the setup wizard can additionally register it user-scoped as a
// fallback). It registers with the internal broker (gets a peer-id), polls for
// inbound Slack messages pushed by the daemon, and surfaces slack_seize /
// slack_release / slack_post tools that call the daemon's control endpoint over
// localhost HTTP (shared-secret bearer token).
//
// Delivery is push-or-poll, decided at handshake: a session launched with the
// --dangerously-load-development-channels allowlist naming this plugin renders
// pushed <channel> blocks; every other session — including all cloud-model
// sessions — is instructed to poll check_messages instead, so inbound Slack
// messages are never silently dropped.
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRpcEndpoint } from "./jsonrpc.mjs";
import { detectChannelsEnabled } from "./session-flags.mjs";

const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS = `You are connected to the slack-bridge remote-control channel. The operator can DM a seized Slack channel from a mobile device and the message arrives here as a <channel source="slack-bridge"> block.

IMPORTANT: When you receive a <channel source="slack-bridge" ...> message, it is a Slack message from the operator. Reply using the slack_post tool (or send_message with to_id "slack-bridge") so your reply posts back to the Slack channel the operator is reading.

Available tools:
- slack_seize: Seize a Slack channel for remote control. With no channel arg the daemon creates a #rc-<name> channel. The name is chosen in this order: the session name the operator set in Claude Code (the chat's custom title, read automatically), then the 'name' arg you pass (a slug derived from the current task context for when the chat isn't named), then the auto ai-title as a last resort. Requires channels:write/manage scopes, else seizes an existing DM. Returns the channel name to report to the operator.
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
    description: "Seize a Slack channel for remote control. With no channel, the daemon creates a #rc-<name> channel. The name is chosen in this order: (1) the session name the operator set in Claude Code (the chat's custom title — read automatically), (2) the 'name' arg you pass, a slug derived from the current task context (branch/plan/feature) for when the operator hasn't named the chat, (3) the auto ai-title as a last resort. Requires channels:write/manage scopes, else seizes an existing DM with the bot. Returns the channel name to report to the operator.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Optional existing channel id to seize (join) instead of creating one." },
        name: { type: "string", description: "A short slug derived from the current task context (git branch, plan slug, or feature name) for when the operator hasn't named the chat. The operator-set custom title always takes priority over this. If omitted and there is no custom title, the auto ai-title is used as a last resort." },
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Default the created channel's name to the session's project dir (cwd basename) so a
// channel describing the chat context "just appears" — the /rc experience — without
// the operator or session having to pass a label. The daemon slugifies this (or an
// explicit `name` arg) into `#rc-<slug>`.
export function defaultChannelName(cwd) {
  const base = String(cwd).split(/[\\/]/).pop() || "";
  return base || null;
}

// Encode a cwd into the segment Claude Code uses for its per-project session dir
// (e.g. `C:\code\long-night` → `C--code-long-night`): backslash, forward slash, and
// colon all rewritten to `-`. Matches the `~/.claude/projects/<encoded-cwd>/` layout.
export function encodeCwd(cwd) {
  return String(cwd).replace(/[\\/:]/g, "-");
}

// Scan the most-recently-modified session JSONL in this project's session dir for the
// latest record of `recordType` and return its `field` value (or null). The session that
// just spawned this MCP server is the one actively writing its JSONL, so
// "most-recently-modified" is a reliable proxy for "the current session" without needing
// CC to pass a session-id env var. `projectsDir` is injectable for tests (defaults to
// `~/.claude/projects`). Reads only the last 1 MB so a multi-hundred-MB transcript does
// not stall a seize.
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
    const tail = Math.min(size, 1_000_000);
    const buf = Buffer.alloc(tail);
    const fd = fs.openSync(fp, "r");
    try {
      fs.readSync(fd, buf, 0, tail, size - tail);
    } finally {
      fs.closeSync(fd);
    }
    let value = null;
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.includes(recordType)) continue;
      try {
        const o = JSON.parse(line);
        if (o && o.type === recordType && o[field]) value = o[field];
      } catch {
        /* partial line at the split boundary — skip */
      }
    }
    return value;
  } catch {
    return null;
  }
}

// The operator-named session name — the chat name the operator set in Claude Code, stored
// as a `custom-title` record. This is the PRIMARY channel-name source: when the operator
// names the chat, the channel "just appears" named after it. Returns null if the operator
// hasn't named the chat (the common case).
export function readSessionName(cwd, opts) {
  return readLatestSessionField(cwd, "custom-title", "customTitle", opts);
}

// The auto-generated `ai-title` — CC's generated summary (often just derived from the
// first message, e.g. "Greeting GLM"). NOT a name the operator chose, so it is a poor
// channel label and is used only as the last-resort fallback before the daemon's peer-id
// fragment: if the operator didn't name the chat AND the session didn't derive a context
// slug, the ai-title is better than nothing.
export function readSessionAiTitle(cwd, opts) {
  return readLatestSessionField(cwd, "ai-title", "aiTitle", opts);
}

// (No cwd-basename channel-name fallback: a channel named after the project dir means
// something broke — the session failed to derive a context slug. The last-resort fallback
// is the auto ai-title; only if THAT is unreadable too does the daemon fall back to its
// peer-id fragment, which is the visible "something broke" signal.)

const isConnectionError = (e) =>
  e instanceof TypeError || /ECONNREFUSED|ECONNRESET|fetch failed|aborted|timeout/i.test(e?.message ?? "");

export function createRemoteMcpServer({
  config,
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
  const brokerUrl = `http://127.0.0.1:${config.remote.brokerPort}`;
  const controlUrl = `http://127.0.0.1:${config.remote.controlPort}`;
  const controlToken = config.remote.controlToken;
  const binPath = fileURLToPath(new URL("../../bin/claude-slack.mjs", import.meta.url));

  let myId = null;
  let myGitRoot = null;
  let channelsAvailable; // memoised: reading the process table is not free

  async function isBrokerAlive() {
    try {
      const res = await _fetch(`${brokerUrl}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  function spawnBroker() {
    const child = _spawn(process.execPath, [binPath, "broker", "run", "--port", String(config.remote.brokerPort)], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.unref();
  }

  let ensuring = null;
  function ensureBroker() {
    ensuring ??= doEnsureBroker().finally(() => { ensuring = null; });
    return ensuring;
  }
  async function doEnsureBroker() {
    if (await isBrokerAlive()) return;
    log("broker not reachable — starting daemon");
    spawnBroker();
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      if (await isBrokerAlive()) return;
    }
    throw new Error("failed to start broker daemon after 6s");
  }

  async function brokerFetch(path, body, { retried = false } = {}) {
    try {
      const res = await _fetch(`${brokerUrl}${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Broker error (${path}): ${res.status} ${await res.text()}`);
      return await res.json();
    } catch (e) {
      if (retried || !isConnectionError(e)) throw e;
      await ensureBroker();
      return brokerFetch(path, body, { retried: true });
    }
  }

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
    const reg = await brokerFetch("/register", { pid: _pid, cwd: _cwd, git_root: myGitRoot, tty: null, summary: "slack-bridge remote" });
    myId = reg.id;
    log(`registered as peer ${myId}`);
  }

  const toolHandlers = {
    async slack_seize(args) {
      if (!myId) return text("Not registered with broker yet", true);
      try {
        // Name precedence: the operator-named session name (the chat's custom title set
        // in CC — a `custom-title` record, read from the session JSONL; the channel "just
        // appears" named after the conversation when the operator named it) → an explicit
        // `name` arg the session derived from task context (branch/plan/feature — used
        // when the operator hasn't named the chat, which is the common case) → the auto
        // `ai-title` (CC's maybe-nonsensical generated summary — last-resort fallback before
        // the daemon's peer-id fragment, because it's better than nothing). There is NO
        // cwd-basename fallback: a channel named after the project dir means something
        // broke, so cwd is never used; if even the ai-title is unreadable, we pass null and
        // the daemon falls back to its peer-id fragment — a `#rc-<peer-id>` name is the
        // visible "something broke" signal. "If you can read it, pass it; if it's not set,
        // derive; if you can't get it, derive."
        const name = readSessionName(_cwd) || args.name || readSessionAiTitle(_cwd) || null;
        const r = await controlFetch("/claim", { peer_id: myId, channel: args.channel ?? null, name });
        const label = r.channel_name ? `#${r.channel_name}` : r.channel;
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
        const result = await brokerFetch("/send-message", { from_id: myId, to_id: "slack-bridge", text: args.message });
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
        const result = await brokerFetch("/send-message", { from_id: myId, to_id: args.to_id, text: args.message });
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
        const result = await brokerFetch("/take-messages", { id: myId });
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
      channelsAvailable ??= _detectChannels();
      if (!channelsAvailable) log("channels unavailable — instructing this session to poll");
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { experimental: { "claude/channel": {} }, tools: {} },
        serverInfo: { name: "slack-bridge-remote", version: SERVER_VERSION },
        instructions: buildInstructions(channelsAvailable),
      };
    }
    if (method === "tools/list") return { tools: TOOLS };
    if (method === "tools/call") {
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
      const result = await brokerFetch("/poll-messages", { id: myId });
      for (const msg of result.messages) {
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
    try { await brokerFetch("/heartbeat", { id: myId }); } catch { /* self-heals on next poll */ }
  }

  async function start() {
    await ensureBroker();
    await register();
    const pollTimer = _setInterval(poll, config.remote.pollIntervalMs);
    pollTimer.unref?.();
    const hbTimer = _setInterval(heartbeat, config.remote.heartbeatIntervalMs);
    hbTimer.unref?.();
    log("MCP endpoint ready");
  }

  return { start, _onRequest: onRequest, _register: register, _poll: poll, _brokerFetch: brokerFetch, _ensureBroker: ensureBroker, _controlFetch: controlFetch, _myId: () => myId };
}