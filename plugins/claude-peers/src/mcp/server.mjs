import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRpcEndpoint } from "./jsonrpc.mjs";
import { detectChannelsEnabled } from "../session-flags.mjs";

const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_VERSION = "0.2.0";

// Kept verbatim from the upstream server — sessions already follow these.
export const INSTRUCTIONS = `You are connected to the claude-peers network. Other Claude Code instances on this machine can see you and send you messages.

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_id.

Available tools:
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo)
- send_message: Send a message to another instance by ID
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- check_messages: Manually check for new messages

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.`;

// Appended only when the push path cannot reach this session. Concrete tool calls,
// not prose: the weakest model that reads this must get a working cron in one pass.
export const POLLING_INSTRUCTIONS = `MESSAGE DELIVERY IN THIS SESSION: push is UNAVAILABLE. This session was not launched with \`--dangerously-load-development-channels plugin:claude-peers\`, so a <channel source="claude-peers"> block will never render for you. Ignore the paragraph above about responding to channel messages — you must poll instead, or you will never see a peer message.

Set up the poll now, before your other startup work:

1. If the CronCreate tool's schema is not loaded, load it first: ToolSearch(query="select:CronCreate")
2. CronCreate(cron="*/3 * * * *", prompt="Call check_messages. If it returns messages, respond to them now with send_message, then resume what you were doing.", recurring=true)

That checks every 3 minutes. The job lives only in this session and expires after 7 days — create it again in your next session. Between ticks, call check_messages directly whenever you are waiting on a peer's reply.`;

export function buildInstructions(channelsAvailable) {
  return channelsAvailable ? INSTRUCTIONS : `${INSTRUCTIONS}\n\n${POLLING_INSTRUCTIONS}`;
}

export const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances running on this machine. Returns their ID, working directory, git repo, and summary.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer ID. Delivery is not instant: it surfaces as a channel notification at the peer's next turn boundary, so a peer sitting idle at its prompt will not see it until it next runs.",
    inputSchema: {
      type: "object",
      properties: {
        to_id: {
          type: "string",
          description: "The peer ID of the target Claude Code instance (from list_peers)",
        },
        message: {
          type: "string",
          description: "The message to send",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on, and the directory you are working IN. Both are visible to other Claude Code instances when they list peers. Call this again whenever what you are doing changes, not only at startup — peers read your summary as current and act on it, and only you can refresh it. Your row shows when you last set it, so a stale one is at least visible.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "A 1-2 sentence summary of your current work",
        },
        cwd: {
          type: "string",
          description:
            "Absolute path of the directory you are actually working in — the worktree, if you are in one. Your peer row's CWD is where your session was launched and cannot detect a worktree you moved into, so peers cannot tell which tree you are committing to unless you say. Run `git rev-parse --show-toplevel` if unsure.",
        },
      },
      required: ["summary", "cwd"],
    },
  },
  {
    name: "check_messages",
    description:
      "Retrieve messages held for you by the broker. Use this when you expect a reply that has not appeared: a channel notification pushed while your session was idle can be missed, and this is the only way to recover it. May re-show a message you already saw.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// Summaries run to several hundred characters and rendered as one line they
// push every following field off the right edge. Wrap on word boundaries;
// break a single over-long token (a path) rather than let it overrun.
export function wrapAt(s, width = 120, indent = "    ") {
  const out = [];
  let line = "";
  for (const word of String(s ?? "").split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { out.push(line); line = word; }
    while (line.length > width) {
      out.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  if (line) out.push(line);
  return out.join(`\n${indent}`);
}

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const errText = (prefix, e) => text(`${prefix}: ${e instanceof Error ? e.message : String(e)}`, true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A thrown fetch means the broker is unreachable; a broker error response is an
// ordinary Error from our own !ok branch and must NOT trigger a respawn.
const isConnectionError = (e) =>
  e instanceof TypeError || /ECONNREFUSED|ECONNRESET|fetch failed|aborted|timeout/i.test(e?.message ?? "");

export function createPeersServer({
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
  const brokerUrl = `http://127.0.0.1:${config.port}`;
  const binPath = fileURLToPath(new URL("../../bin/claude-peers.mjs", import.meta.url));

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
    // detached + ignored stdio: the broker must outlive this session's process
    // tree — chaining its lifetime to one session was an upstream defect.
    const child = _spawn(process.execPath, [binPath, "broker", "run"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  }

  // single-flight: concurrent failures (poll + heartbeat racing) share one respawn
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Broker error (${path}): ${res.status} ${await res.text()}`);
      return await res.json();
    } catch (e) {
      if (retried || !isConnectionError(e)) throw e;
      await ensureBroker();
      return brokerFetch(path, body, { retried: true });
    }
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
    const reg = await brokerFetch("/register", {
      pid: _pid, cwd: _cwd, git_root: myGitRoot, tty: null, summary: "",
    });
    myId = reg.id;
    log(`registered as peer ${myId}`);
  }

  // --- tool handlers ---

  const toolHandlers = {
    async list_peers(args) {
      const scope = args.scope;
      try {
        const peers = await brokerFetch("/list-peers", {
          scope, cwd: _cwd, git_root: myGitRoot, exclude_id: myId,
        });
        if (peers.length === 0) return text(`No other Claude Code instances found (scope: ${scope}).`);
        const lines = peers.map((p) => {
          // The reported working directory wins: the registered `cwd` is only
          // ever where the session LAUNCHED — fixed when the MCP server spawns,
          // and unmoved by the agent's own `cd`, so a session that created a
          // worktree mid-run reports the checkout it started in.
          const parts = [`ID: ${p.id}`, `PID: ${p.pid}`, `CWD: ${p.work_cwd || p.cwd}`];
          // The checkout the session was launched against, and what repo scope
          // groups on — deliberately NOT the worktree above it, so a fleet
          // working one repository from separate trees still finds each other.
          if (p.git_root) parts.push(`Checkout: ${p.git_root}`);
          if (p.tty) parts.push(`TTY: ${p.tty}`);
          if (p.summary) parts.push(`Summary: ${wrapAt(p.summary)}`);
          // Distinct from Last seen, which the heartbeat bumps every few
          // seconds: a summary can be hours older than the liveness beside it
          // and still read as current. Covers the working directory too — one
          // call sets both.
          if (p.summary) parts.push(`Summary set: ${p.summary_updated_at ?? "unknown"}`);
          parts.push(`Last seen: ${p.last_seen}`);
          return parts.join("\n  ");
        });
        return text(`Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`);
      } catch (e) {
        return errText("Error listing peers", e);
      }
    },

    async send_message(args) {
      if (!myId) return text("Not registered with broker yet", true);
      try {
        const result = await brokerFetch("/send-message", { from_id: myId, to_id: args.to_id, text: args.message });
        if (!result.ok) return text(`Failed to send: ${result.error}`, true);
        return text(`Message sent to peer ${args.to_id}`);
      } catch (e) {
        return errText("Error sending message", e);
      }
    },

    async set_summary(args) {
      if (!myId) return text("Not registered with broker yet", true);
      // The registered cwd is where the SESSION launched; a session that moves
      // into a worktree mid-run cannot detect it (the MCP server's own cwd is
      // fixed at spawn), so the working directory has to be told to us.
      const workCwd = String(args.cwd ?? "").trim();
      if (!workCwd) {
        return text("set_summary requires `cwd` — the directory you are actually working in. Run `git rev-parse --show-toplevel` if unsure.", true);
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary: args.summary, cwd: workCwd });
        return text(`Summary updated: "${args.summary}" (working in ${workCwd})`);
      } catch (e) {
        return errText("Error setting summary", e);
      }
    },

    async check_messages() {
      if (!myId) return text("Not registered with broker yet", true);
      try {
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

  // --- rpc dispatch ---

  async function onRequest(method, params) {
    if (method === "initialize") {
      channelsAvailable ??= _detectChannels();
      if (!channelsAvailable) log("channels unavailable — instructing this session to poll");
      return {
        // we implement 2024-11-05 semantics — never echo an arbitrary requested version
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { experimental: { "claude/channel": {} }, tools: {} },
        serverInfo: { name: "claude-peers", version: SERVER_VERSION },
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
        let fromSummary = "";
        let fromCwd = "";
        try {
          const peers = await brokerFetch("/list-peers", {
            scope: "machine", cwd: _cwd, git_root: myGitRoot, include_adhoc: true,
          });
          const sender = peers.find((p) => p.id === msg.from_id);
          if (sender) {
            fromSummary = sender.summary;
            fromCwd = sender.cwd;
          }
        } catch {
          // sender context is best-effort
        }
        rpc.notify("notifications/claude/channel", {
          content: msg.text,
          meta: { from_id: msg.from_id, from_summary: fromSummary, from_cwd: fromCwd, sent_at: msg.sent_at },
        });
        log(`pushed message from ${msg.from_id}`);
      }
    } catch (e) {
      log(`poll error: ${e.message}`);
    }
  }

  async function heartbeat() {
    if (!myId) return;
    try {
      await brokerFetch("/heartbeat", { id: myId });
    } catch {
      // non-critical; the next poll's brokerFetch self-heals the broker anyway
    }
  }

  async function start() {
    await ensureBroker();
    await register();
    const pollTimer = _setInterval(poll, config.pollIntervalMs);
    pollTimer.unref?.();
    const hbTimer = _setInterval(heartbeat, config.heartbeatIntervalMs);
    hbTimer.unref?.();
    log("MCP endpoint ready");
  }

  // Underscored internals are the test surface; start() is the runtime entry.
  return {
    start,
    _onRequest: onRequest,
    _register: register,
    _poll: poll,
    _brokerFetch: brokerFetch,
    _ensureBroker: ensureBroker,
  };
}
