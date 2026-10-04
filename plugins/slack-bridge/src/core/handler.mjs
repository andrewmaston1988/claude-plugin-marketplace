import { runClaude } from "./claude-subprocess.mjs";
import { readSession, channelModel, writeSession, clearSession, setChannelModel } from "./session-value.mjs";
import { startHeartbeat } from "../heartbeat/loop.mjs";
import { fetchHistory } from "../history-bootstrap/index.mjs";
import { safeUpdate, postResponse, postError } from "./reply-post.mjs";
import { routeToLiveSession, startReplyLoop, _resetRouteState } from "./live-route.mjs";

export { safeUpdate, postResponse, postError, routeToLiveSession, startReplyLoop, _resetRouteState };

const DEDUP_SIZE = 64;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MODEL_HINT ="No model set for this channel — type /model <name>, e.g. /model sonnet.";
const recentMsgIds = new Set();  // persisted across restarts via session store
const activeProcs = new Map();   // channel → child process
let _dedupStore = null;

/** Load persisted dedup state from store; call once in startBridge. */
export function loadDedup(store) {
  _dedupStore = store;
  const saved = store.get("__dedup__");
  if (Array.isArray(saved)) saved.forEach(id => recentMsgIds.add(id));
}

function isDupe(msgId) {
  if (!msgId) return false;
  if (recentMsgIds.has(msgId)) return true;
  recentMsgIds.add(msgId);
  if (recentMsgIds.size > DEDUP_SIZE) recentMsgIds.delete(recentMsgIds.values().next().value);
  _dedupStore?.set("__dedup__", [...recentMsgIds]);
  return false;
}

// channel_join / channel_topic are noise: the auto-invite join would otherwise wake
// the live session before the operator has typed anything.
const SKIPPED_SUBTYPES = new Set([
  "message_changed", "message_deleted", "channel_join", "channel_topic",
]);

function shouldSkip(payload) {
  if (payload.bot_id || payload.subtype === "bot_message") return "bot_message";
  if (SKIPPED_SUBTYPES.has(payload.subtype)) return payload.subtype;
  if (isDupe(payload.client_msg_id)) return "dedup";
  return null;
}

function stripBotMention(text, botUserId) {
  if (!botUserId) return text;
  return text.replace(new RegExp(`^<@${botUserId}>\\s*`), "").trim();
}

function sessionKey(payload, config) {
  const mode = config.slack?.sessionKey ?? "channel-thread";
  if (mode === "channel-thread" && payload.thread_ts) {
    return `${payload.channel}:${payload.thread_ts}`;
  }
  return payload.channel;
}

function deriveTitle(text, maxLen = 60) {
  const first = text.split("\n")[0].trim();
  return first.length <= maxLen ? first : first.slice(0, maxLen - 1) + "…";
}

export async function handleMessage({ web, store, queue, config, log, payload, botUserId, isFirstInSession, extensions, remote, _runClaude, _startHeartbeat }) {
  const skipReason = shouldSkip(payload);
  if (skipReason) {
    log.info("message skipped", { channel: payload.channel, ts: payload.ts, reason: skipReason });
    return;
  }

  if (config.slack?.onlyChannel && payload.channel !== config.slack.onlyChannel) {
    log.info("message skipped", { channel: payload.channel, ts: payload.ts, reason: "onlyChannel" });
    return;
  }

  const text = stripBotMention(payload.text ?? "", botUserId);
  if (!text) {
    log.info("message skipped", { channel: payload.channel, ts: payload.ts, reason: "empty_after_strip" });
    return;
  }

  const key = sessionKey(payload, config);
  const channel = payload.channel;
  const threadTs = payload.thread_ts ?? null;

  queue.enqueue(channel, async () => {
    // --- remote-control routing branch ---
    // If this channel has been claimed by a live interactive session, route the
    // message to it via the internal broker instead of spawning `claude -p`. A
    // dead/missing claiming peer falls through to the spawn path (after reaping
    // the stale claim) so Slack is never silent.
    const claim = remote?.claims?.get(channel) ?? null;
    let brokerDown = false;
    if (claim && remote?.broker) {
      // null = broker unreachable: keep the claim and serve THIS message via the
      // spawn path — a transient outage costs per-message spawns, not the claim;
      // routing resumes when the broker returns.
      let alive = null;
      try { alive = await remote.broker.isAlive(claim.peer_id); } catch { /* fall through */ }
      if (alive === true) {
        await routeToLiveSession({
          web, channel, threadTs, text, claim, broker: remote.broker, config, log,
          cmdEcho: deriveTitle(text), _startHeartbeat,
        });
        return;
      }
      if (alive === false) {
        try { await remote.claims.release(claim.peer_id); } catch { /* reaped below */ }
        log.info("remote-control claim reaped (peer dead), falling back to spawn", { channel, peer_id: claim.peer_id });
      }
      brokerDown = alive === null;
    }

    // No model, no spawn: /model must pick one first. Exception: a claimed channel whose
    // broker is unreachable belongs to a live session, so it spawns modelless rather than go silent.
    const model = channelModel(store, channel);
    if (!model && !brokerDown) {
      const hint = { channel, text: MODEL_HINT };
      if (threadTs) hint.thread_ts = threadTs;
      try { await web.chatPostMessage(hint); } catch (e) { log.error("failed to post model hint", { channel, error: e.message }); }
      return;
    }

    const existingSession = readSession(store, key).sessionId ?? null;
    const cmdEcho = deriveTitle(text);
    let placeholderTs = null;
    let heartbeat = null;

    // Fetch channel history as context prelude for new sessions (non-DM channels only)
    let prelude = "";
    if (!existingSession && payload.channel_type !== "im" && config.slack?.historyLimit) {
      prelude = await fetchHistory({ web, channel, limit: config.slack.historyLimit, log });
    }

    // Post placeholder
    try {
      const postParams = {
        channel,
        text: "",
        attachments: [{ color: "#808080", text: `_${cmdEcho}_`, mrkdwn_in: ["text"] }],
      };
      if (threadTs) postParams.thread_ts = threadTs;
      const posted = await web.chatPostMessage(postParams);
      placeholderTs = posted.ts;
    } catch (e) {
      log.error("failed to post placeholder", { channel, error: e.message });
      return;
    }

    // Start heartbeat
    heartbeat = startHeartbeat({
      web, channel, ts: placeholderTs, cmdEcho, log: log.child("heartbeat"),
      extensions, sessionId: existingSession ?? undefined, config,
    });
    // Haiku verb mode: seed one verb per message (batch output; no per-tool streaming).
    if (config.slack?.verbMode === "haiku") {
      heartbeat.setTool("working", { prompt: text.slice(0, 80) });
    }

    // Prompt injection from extensions
    let inject = null;
    if (extensions) {
      try {
        inject = await extensions.runPromptInject({
          channel,
          sessionId: existingSession ?? undefined,
          isFirstMessage: !existingSession,
          message: text,
          config,
        });
      } catch { /* ignored */ }
    }

    try {
      const runClaudeFn = _runClaude ?? runClaude;
      const { result: claudeResult, sessionId } = await runClaudeFn({
        cwd: config.claude.cwd,
        addDir: config.claude.addDir,
        prompt: (inject ? inject + "\n" : "") + prelude + text,
        sessionId: existingSession ?? undefined,
        model: model ?? undefined,
        proxy: config.proxy,
        timeoutMs: config.claude.timeout,
        onStarted: child => { activeProcs.set(channel, child); },
        env: {},
      });

      activeProcs.delete(channel);
      // A /model switch mid-run already cleared this key; the old backend's session must not return.
      if (sessionId && channelModel(store, channel) === model) writeSession(store, key, { sessionId });

      // .py canon (slack_bridge.py:685-688): stop the heartbeat AND join it before
      // posting the reply, so a final heartbeat tick can't land chatUpdate(text:"")
      // after the reply and clobber the body. stop() returns the in-flight update's
      // promise (capped at 3s) — awaiting it is the join.
      await heartbeat.stop();

      await postResponse({
        web, channel, placeholderTs, threadTs,
        responseText: claudeResult, existingSession, isFirstInSession, cmdEcho,
        extensions, sessionId, config,
      });
    } catch (e) {
      await heartbeat?.stop();
      activeProcs.delete(channel);
      log.error("claude error", { channel, error: e.message });
      await postError({ web, channel, placeholderTs, threadTs, message: e.message });
    } finally {
      // One-shot restart signal — clear after first message in any session
      delete process.env.CLAUDE_BRIDGE_RESTARTED;
    }
  });
}

export function killActive(channel) {
  const child = activeProcs.get(channel);
  if (child) { child.kill("SIGTERM"); activeProcs.delete(channel); return true; }
  return false;
}

/**
 * Post a standalone "🔄 *Bridge restarted*" notice to the most recent DM
 * session on startup — mirrors the historic .py _post_startup_notification.
 * The mjs port had dropped this (only the inject-into-claude-prompt path
 * survived), so "Bridge restarted" stopped printing on restart. DM session
 * keys are bare channel ids (no ":"); thread sessions are "channel:thread_ts",
 * so the filter skips threads and targets the operator's DM.
 */
export async function postStartupNotification({ web, store, log }) {
  const sessions = store.all();
  // Only DM ids start with "D". Channel sessions are bare ids too, and the newest
  // may be archived (is_archived); internal keys like "__dedup__" are bare as well.
  const dmChannels = Object.keys(sessions).filter(k => /^D[A-Z0-9]+$/.test(k));
  if (!dmChannels.length) return;
  const channel = dmChannels[dmChannels.length - 1];
  try {
    await web.chatPostMessage({ channel, text: "🔄 *Bridge restarted*" });
    log?.info("startup notification posted", { channel });
  } catch (e) {
    log?.warn("startup notification failed", { error: e.message });
  }
}

export function startBridge({ config, log, web, socket, store, queue, extensions, remote }) {
  loadDedup(store);

  // Fire-and-forget: tell the operator the bridge is back. Errors are swallowed
  // inside postStartupNotification so a Slack hiccup can't block startup.
  postStartupNotification({ web, store, log }).catch(() => {});

  let botUserId = null;
  const sessionFirstMessage = new Set();

  web.authTest().then(info => {
    botUserId = info.user_id;
    log.info("authenticated", { botUserId, teamId: info.team_id });
  }).catch(e => log.error("authTest failed", { message: e.message }));

  socket.on("event", ({ payload: envelope, ack }) => {
    ack();
    const event = envelope?.event ?? envelope;
    if (event?.type === "message") {
      const isFirst = !sessionFirstMessage.has(event.channel);
      if (isFirst) sessionFirstMessage.add(event.channel);
      handleMessage({ web, store, queue, config, log, payload: event, botUserId, isFirstInSession: isFirst, extensions, remote })
        .catch(e => log.error("handleMessage unhandled", { error: e.message }));
    }
  });

  socket.on("slash_command", ({ payload, ack }) => {
    ack();
    handleSlashCommand({ web, store, queue, config, log, payload, botUserId, extensions })
      .catch(e => log.error("slash command unhandled", { error: e.message }));
  });

  // Every message the live session (or its turn mirror) sends reaches its claim
  // channel through ONE daemon-side consumer: a reply sent with no window open
  // used to sit until the 30 s drain tick, and a window/drain race could destroy
  // the reply a window was waiting for.
  let stopReplyLoop = () => {};
  if (remote?.broker && remote?.claims) {
    const replyLoop = startReplyLoop({ broker: remote.broker, claims: remote.claims, web, config, log });
    stopReplyLoop = () => replyLoop.stop();
  }

  socket.start();
  log.info("bridge started");
  return { stopReplyLoop };
}

async function handleSlashCommand({ web, store, queue, config, log, payload, botUserId, extensions }) {
  const cmd = payload.command ?? "";
  const channel = payload.channel_id ?? payload.channel;

  switch (cmd) {
    case "/new":
    case "/reset": {
      clearSession(store, channel);
      await web.chatPostMessage({ channel, text: "_Session cleared. Start a new message to begin fresh._" });
      break;
    }
    case "/model": {
      const name = (payload.text ?? "").trim();
      if (!name) {
        await web.chatPostMessage({ channel, text: `Model: ${channelModel(store, channel) ?? "none"}` });
        break;
      }
      // The name reaches a cmd.exe argv on Windows, so only plain model ids pass.
      if (!MODEL_NAME.test(name)) {
        await web.chatPostMessage({ channel, text: `Invalid model name: use letters, digits and . _ : - only, e.g. /model sonnet.` });
        break;
      }
      setChannelModel(store, channel, name);
      await web.chatPostMessage({ channel, text: `Model set: ${name}` });
      break;
    }
    case "/restart": {
      await web.chatPostMessage({ channel, text: "_Restarting bridge..._" });
      process.exit(0);
      break;
    }
    case "/stop": {
      const killed = killActive(channel);
      if (!killed) await web.chatPostMessage({ channel, text: "_No active Claude session to stop._" });
      break;
    }
    default: {
      const fakePayload = {
        type: "message",
        channel,
        text: payload.text ?? cmd,
        client_msg_id: `slash-${Date.now()}`,
      };
      await handleMessage({ web, store, queue, config, log, payload: fakePayload, botUserId, isFirstInSession: false, extensions });
    }
  }
}
