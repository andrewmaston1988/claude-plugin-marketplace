// Forked from plugins/claude-peers/src/mcp/server.mjs. The live interactive session
// loads this stdio MCP server (user-scoped — see README; plugin-declared MCP does
// not render notifications/claude/channel as of 2026-07-16). It registers with the
// internal broker (gets a peer-id), polls for inbound Slack messages pushed by the
// daemon, and surfaces slack_seize / slack_release / slack_post tools that call the
// daemon's control endpoint over localhost HTTP (shared-secret bearer token).
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRpcEndpoint } from "./jsonrpc.mjs";

const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS = `You are connected to the slack-bridge remote-control channel. The operator can DM a seized Slack channel from a mobile device and the message arrives here as a <channel source="slack-bridge"> block.

IMPORTANT: When you receive a <channel source="slack-bridge" ...> message, it is a Slack message from the operator. Reply using the slack_post tool (or send_message with to_id "slack-bridge") so your reply posts back to the Slack channel the operator is reading.

Available tools:
- slack_seize: Seize a Slack channel for remote control. With no channel arg the daemon creates one (if scopes allow) or seizes an existing DM. Returns the channel name to report to the operator.
- slack_release: Release the seized channel.
- slack_post: Post a message to the seized Slack channel (your reply to the operator).
- send_message: Send a message to another peer by id. With to_id "slack-bridge" it posts to the seized Slack channel (passthrough).
- check_messages: Manually poll for inbound Slack messages (fallback).`;

export const TOOLS = [
  {
    name: "slack_seize",
    description: "Seize a Slack channel for remote control. With no channel, the daemon creates a #ln-<short> channel (if the app has channels:write/manage scopes) or seizes an existing DM with the bot. Returns the channel name to report to the operator.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Optional existing channel id to seize (join) instead of creating one." },
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
    description: "Manually check for new inbound Slack messages. Messages are normally pushed automatically via channel notifications, but you can use this as a fallback.",
    inputSchema: { type: "object", properties: {} },
  },
];

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const errText = (prefix, e) => text(`${prefix}: ${e instanceof Error ? e.message : String(e)}`, true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
} = {}) {
  const brokerUrl = `http://127.0.0.1:${config.remote.brokerPort}`;
  const controlUrl = `http://127.0.0.1:${config.remote.controlPort}`;
  const controlToken = config.remote.controlToken;
  const binPath = fileURLToPath(new URL("../../bin/claude-slack.mjs", import.meta.url));

  let myId = null;
  let myGitRoot = null;

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
        const r = await controlFetch("/claim", { peer_id: myId, channel: args.channel ?? null });
        const name = r.channel_name ? `#${r.channel_name}` : r.channel;
        return text(`📱 Slack remote ready: ${name}${r.topic ? ` — ${r.topic}` : ""}. DM it from a second device; inbound messages arrive here as a <channel source=\"slack-bridge\"> block. Reply with slack_post.`);
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
        const result = await brokerFetch("/poll-messages", { id: myId });
        if (result.messages.length === 0) return text("No new messages.");
        const lines = result.messages.map((m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`);
        return text(`${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`);
      } catch (e) {
        return errText("Error checking messages", e);
      }
    },
  };

  async function onRequest(method, params) {
    if (method === "initialize") {
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { experimental: { "claude/channel": {} }, tools: {} },
        serverInfo: { name: "slack-bridge-remote", version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
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

  return { start, _onRequest: onRequest, _register: register, _poll: poll, _brokerFetch: brokerFetch, _ensureBroker: ensureBroker, _controlFetch: controlFetch };
}