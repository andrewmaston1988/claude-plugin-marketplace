import { runClaude } from "./claude-subprocess.mjs";
import { mdToSlack, mdToBlocks, hasTable } from "../markdown/index.mjs";
import { startHeartbeat } from "../heartbeat/loop.mjs";
import { fetchHistory } from "../history-bootstrap/index.mjs";

const DEDUP_SIZE = 64;
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

function shouldSkip(payload) {
  if (payload.bot_id || payload.subtype === "bot_message") return "bot_message";
  if (payload.subtype === "message_changed" || payload.subtype === "message_deleted") return payload.subtype;
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

function splitResponse(text, maxLen = 3000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  const paras = text.split(/\n\n+/);
  let current = "";
  for (const para of paras) {
    if (current.length + para.length + 2 > maxLen) {
      if (current) chunks.push(current.trim());
      current = para.length > maxLen ? para.slice(0, maxLen) : para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.slice(0, maxLen)];
}

/**
 * Update a placeholder message; if Slack reports it no longer exists,
 * fall back to posting a new message in the same thread.
 */
export async function safeUpdate({ web, channel, ts, params, threadTs }) {
  try {
    await web.chatUpdate({ channel, ts, ...params });
  } catch (e) {
    if (e.slackError === "message_not_found" || e.slackError === "cant_update_message") {
      const postParams = { channel, ...params };
      if (threadTs) postParams.thread_ts = threadTs;
      await web.chatPostMessage(postParams);
    } else {
      throw e;
    }
  }
}

export async function handleMessage({ web, store, queue, config, log, payload, botUserId, isFirstInSession, extensions }) {
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
    const existingSession = store.get(key);
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
      const { result: claudeResult, sessionId } = await runClaude({
        cwd: config.claude.cwd,
        addDir: config.claude.addDir,
        prompt: (inject ? inject + "\n" : "") + prelude + text,
        sessionId: existingSession ?? undefined,
        timeoutMs: config.claude.timeout,
        onStarted: child => { activeProcs.set(channel, child); },
        env: {},
      });

      activeProcs.delete(channel);
      if (sessionId) store.set(key, sessionId);

      heartbeat.stop();

      const title = (!existingSession && isFirstInSession) ? `*${cmdEcho}*\n\n` : null;
      const responseText = title ? title + (claudeResult ?? "") : (claudeResult ?? "");

      if (hasTable(responseText)) {
        const blocks = mdToBlocks(responseText);
        if (blocks) {
          await web.chatDelete({ channel, ts: placeholderTs });
          const postParams = { channel, text: cmdEcho, blocks };
          if (threadTs) postParams.thread_ts = threadTs;
          await web.chatPostMessage(postParams);
          return;
        }
      }

      const mrkdwn = mdToSlack(responseText);
      const chunks = splitResponse(mrkdwn);

      if (chunks.length === 1) {
        await safeUpdate({
          web, channel, ts: placeholderTs, threadTs,
          params: { text: "", attachments: [{ color: "#36a64f", text: mrkdwn, mrkdwn_in: ["text"] }] },
        });
      } else {
        await web.chatDelete({ channel, ts: placeholderTs });
        for (const chunk of chunks) {
          const postParams = { channel, text: chunk };
          if (threadTs) postParams.thread_ts = threadTs;
          await web.chatPostMessage(postParams);
        }
      }
    } catch (e) {
      heartbeat?.stop();
      activeProcs.delete(channel);
      log.error("claude error", { channel, error: e.message });
      try {
        await safeUpdate({
          web, channel, ts: placeholderTs, threadTs,
          params: { text: "", attachments: [{ color: "#e01e5a", text: `_Error: ${e.message}_`, mrkdwn_in: ["text"] }] },
        });
      } catch { /* placeholder already gone; error was already logged above */ }
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

export function startBridge({ config, log, web, socket, store, queue, extensions }) {
  loadDedup(store);

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
      handleMessage({ web, store, queue, config, log, payload: event, botUserId, isFirstInSession: isFirst, extensions })
        .catch(e => log.error("handleMessage unhandled", { error: e.message }));
    }
  });

  socket.on("slash_command", ({ payload, ack }) => {
    ack();
    handleSlashCommand({ web, store, queue, config, log, payload, botUserId, extensions })
      .catch(e => log.error("slash command unhandled", { error: e.message }));
  });

  socket.start();
  log.info("bridge started");
}

async function handleSlashCommand({ web, store, queue, config, log, payload, botUserId, extensions }) {
  const cmd = payload.command ?? "";
  const channel = payload.channel_id ?? payload.channel;

  switch (cmd) {
    case "/new":
    case "/reset": {
      store.delete(channel);
      await web.chatPostMessage({ channel, text: "_Session cleared. Start a new message to begin fresh._" });
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
