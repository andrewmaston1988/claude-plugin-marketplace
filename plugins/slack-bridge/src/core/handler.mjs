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

export async function handleMessage({ web, store, queue, config, log, payload, botUserId, isFirstInSession, extensions, remote, _runClaude }) {
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
    if (claim && remote?.broker) {
      // null = broker unreachable: keep the claim and serve THIS message via the
      // spawn path — a transient outage costs per-message spawns, not the claim;
      // routing resumes when the broker returns.
      let alive = null;
      try { alive = await remote.broker.isAlive(claim.peer_id); } catch { /* fall through */ }
      if (alive === true) {
        await routeToLiveSession({ web, channel, threadTs, text, claim, broker: remote.broker, config, log, cmdEcho: deriveTitle(text) });
        return;
      }
      if (alive === false) {
        try { await remote.claims.release(claim.peer_id); } catch { /* reaped below */ }
        log.info("remote-control claim reaped (peer dead), falling back to spawn", { channel, peer_id: claim.peer_id });
      }
    }

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
      const runClaudeFn = _runClaude ?? runClaude;
      const { result: claudeResult, sessionId } = await runClaudeFn({
        cwd: config.claude.cwd,
        addDir: config.claude.addDir,
        prompt: (inject ? inject + "\n" : "") + prelude + text,
        sessionId: existingSession ?? undefined,
        model: config.claude.model,
        proxy: config.proxy,
        timeoutMs: config.claude.timeout,
        onStarted: child => { activeProcs.set(channel, child); },
        env: {},
      });

      activeProcs.delete(channel);
      if (sessionId) store.set(key, sessionId);

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
  // DM session keys are bare channel ids (no ":"); thread sessions are
  // "channel:thread_ts". Skip internal keys like "__dedup__" — they're bare-id
  // (no ":") so they'd pass the DM filter and get picked as the target channel,
  // producing a channel_not_found error and swallowing the restart notice.
  const dmChannels = Object.keys(sessions).filter(k => !k.includes(":") && !k.startsWith("__"));
  if (!dmChannels.length) return;
  const channel = dmChannels[dmChannels.length - 1];
  try {
    await web.chatPostMessage({ channel, text: "🔄 *Bridge restarted*" });
    log?.info("startup notification posted", { channel });
  } catch (e) {
    log?.warn("startup notification failed", { error: e.message });
  }
}

/**
 * Post claude's reply — mirrors the historic .py recipe: the reply is the clean
 * message body (chat_update text=response_text), NOT wrapped in a Slack attachment.
 * The mjs port had put the whole reply inside attachments[].text, so it rendered
 * inside the "|" attachment bar. Tables use Block Kit blocks; long replies split
 * into multiple plain-text posts. The first-in-session title uses **bold** (md)
 * so mdToSlack converts it to *bold* (mrkdwn), matching the .py.
 */
export async function postResponse({ web, channel, placeholderTs, threadTs, responseText, existingSession, isFirstInSession, cmdEcho, extensions, sessionId, config }) {
  const title = (!existingSession && isFirstInSession) ? `**${cmdEcho}**\n\n` : null;
  const fullText = title ? title + (responseText ?? "") : (responseText ?? "");

  // End-of-turn progress attachment — historic .py parity (slack_bridge.py:711-714
  // posted _progress_snippet() as a coloured attachment on the reply). Sourced from
  // the pipeline progress-steps DB via the extension's responseAugment hook; null
  // when there's no active progress or no extension. Never let it fail the reply.
  let progressAttachment = null;
  if (extensions) {
    try {
      const snippet = await extensions.runResponseAugment({ channel, sessionId, isFirstInSession, config });
      if (snippet) progressAttachment = { color: "#808080", text: snippet, mrkdwn_in: ["text"] };
    } catch { /* progress is a sidebar; never fail the response on it */ }
  }

  if (hasTable(fullText)) {
    const blocks = mdToBlocks(fullText);
    if (blocks) {
      await web.chatDelete({ channel, ts: placeholderTs });
      const postParams = { channel, text: cmdEcho, blocks };
      if (threadTs) postParams.thread_ts = threadTs;
      await web.chatPostMessage(postParams);
      if (progressAttachment) await postProgressAttachment({ web, channel, threadTs, attachment: progressAttachment });
      return;
    }
  }

  const mrkdwn = mdToSlack(fullText);
  const chunks = splitResponse(mrkdwn);

  if (chunks.length === 1) {
    // Reply as the message body — no attachment wraps it (the .py recipe).
    // The progress attachment rides along on the same updated message (text + attachment).
    const params = { text: mrkdwn };
    if (progressAttachment) params.attachments = [progressAttachment];
    await safeUpdate({ web, channel, ts: placeholderTs, threadTs, params });
  } else {
    await web.chatDelete({ channel, ts: placeholderTs });
    for (let i = 0; i < chunks.length; i++) {
      const postParams = { channel, text: chunks[i] };
      if (threadTs) postParams.thread_ts = threadTs;
      // Attach the progress snippet to the final chunk so it appears once, at the end.
      if (progressAttachment && i === chunks.length - 1) postParams.attachments = [progressAttachment];
      await web.chatPostMessage(postParams);
    }
  }
}

/**
 * Post the end-of-turn progress snippet as a standalone coloured attachment —
 * used when the reply itself is Block Kit blocks (blocks + attachments don't
 * combine cleanly on one message). Swallows Slack errors; progress is a sidebar.
 */
async function postProgressAttachment({ web, channel, threadTs, attachment }) {
  const postParams = { channel, text: "", attachments: [attachment] };
  if (threadTs) postParams.thread_ts = threadTs;
  try { await web.chatPostMessage(postParams); } catch { /* sidebar; ignore */ }
}

/**
 * Post an error as plain message text — .py recipe: text="_Error: …_", attachments=[].
 * The mjs port had wrapped it in a red attachment; restore plain text so the error
 * isn't inside the "|" bar. Swallows Slack errors (placeholder may already be gone).
 */
export async function postError({ web, channel, placeholderTs, threadTs, message }) {
  try {
    await safeUpdate({ web, channel, ts: placeholderTs, threadTs, params: { text: `_Error: ${message}_` } });
  } catch { /* placeholder already gone; error was already logged by the caller */ }
}

// Peers with a route polling right now. The idle drain skips these: /poll-messages
// marks what it returns delivered, and pollReply ignores delivered messages, so a
// drain that ran underneath a live window would destroy the reply it was sent for.
const activeRoutes = new Set();

/**
 * Route a claimed channel's message to its live session: placeholder, broker
 * send, poll the peer's reply, post it in place. On timeout the claim is
 * retained (slow, not dead) and "didn't reply in time" is posted.
 */
export async function routeToLiveSession({ web, channel, threadTs, text, claim, broker, config, log, cmdEcho }) {
  const timeoutMs = config.remote?.replyTimeoutMs ?? 300_000;
  const pollIntervalMs = config.remote?.replyPollIntervalMs ?? 1_000;

  // Post whatever THIS peer sent that no window consumed, before the new
  // placeholder: a late answer to a previous message is never served as this
  // message's reply, and is never destroyed unread either. from_id scoping plus
  // one-claim-per-peer (claims store) keeps concurrent claimed channels from
  // draining each other's replies.
  await drainLeftoverReplies({ broker, web, channel, threadTs, peerId: claim.peer_id, log });

  let placeholderTs = null;
  try {
    const postParams = {
      channel,
      text: "",
      attachments: [{ color: "#808080", text: `📱 _routed to live session…_`, mrkdwn_in: ["text"] }],
    };
    if (threadTs) postParams.thread_ts = threadTs;
    const posted = await web.chatPostMessage(postParams);
    placeholderTs = posted.ts;
  } catch (e) {
    log.error("failed to post routed placeholder", { channel, error: e.message });
    return;
  }

  activeRoutes.add(claim.peer_id);
  let replies = [];
  try {
    try {
      const r = await broker.sendMessage("slack-bridge", claim.peer_id, text);
      if (r && r.ok === false) throw new Error(r.error ?? "send failed");
    } catch (e) {
      log.error("failed to route to live session", { channel, error: e.message });
      await postError({ web, channel, placeholderTs, threadTs, message: `failed to route to live session: ${e.message}` });
      return;
    }
    replies = await pollReply({ broker, peerId: claim.peer_id, timeoutMs, pollIntervalMs, log });
  } finally {
    activeRoutes.delete(claim.peer_id);
  }
  if (replies.length) {
    for (let i = 0; i < replies.length; i++) {
      try {
        if (i === 0) {
          // The first reply replaces the placeholder; the rest post after it —
          // a session that replies in several chunks must not have chunks 2..N
          // silently discarded by the next routed message's pre-send drain.
          await postResponse({
            web, channel, placeholderTs, threadTs,
            responseText: replies[i].text, existingSession: claim.peer_id, isFirstInSession: false,
            cmdEcho, extensions: null, sessionId: null, config,
          });
        } else {
          const postParams = { channel, text: replies[i].text };
          if (threadTs) postParams.thread_ts = threadTs;
          await web.chatPostMessage(postParams);
        }
      } catch (e) {
        log.error("failed to post live-session reply", { channel, error: e.message });
        await postError({ web, channel, placeholderTs: null, threadTs, message: `live session reply post failed: ${e.message}` });
      }
    }
  } else {
    await postError({ web, channel, placeholderTs, threadTs, message: "live session didn't reply in time" });
  }
}

// Poll this peer's reply only — from_id-scoped, and the claims store allows one
// channel per peer, so concurrent claims can't take each other's replies.
async function pollReply({ broker, peerId, timeoutMs, pollIntervalMs, log }) {
  const deadline = Date.now() + timeoutMs;
  const out = [];
  while (Date.now() < deadline) {
    let msgs = [];
    try { msgs = await broker.pollMessages("slack-bridge", peerId) ?? []; } catch (e) { log?.warn?.("poll error", { error: e.message }); }
    out.push(...msgs);
    // Drain until an empty poll: a multi-chunk reply (several slack_post calls in
    // quick succession) must arrive whole, not just its first chunk.
    if (out.length && msgs.length === 0) return out;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return out;
}

// Post drained replies that no window consumed. A slack_post landing after its
// window closed — or with none open — would otherwise be destroyed by the next
// drain while the session was told it had sent.
async function postLeftovers({ web, channel, threadTs, msgs, log }) {
  let posted = 0;
  for (const m of msgs) {
    if (!m?.text) continue;
    try {
      const p = { channel, text: m.text };
      if (threadTs) p.thread_ts = threadTs;
      await web.chatPostMessage(p);
      posted++;
    } catch (e) {
      log.warn("failed to post a late live-session reply", { channel, error: e.message });
    }
  }
  return posted;
}

async function drainLeftoverReplies({ broker, web, channel, threadTs, peerId, log }) {
  let msgs = [];
  try { msgs = await broker.pollMessages("slack-bridge", peerId) ?? []; } catch { return 0; }
  if (!msgs.length) return 0;
  const posted = await postLeftovers({ web, channel, threadTs, msgs, log });
  if (posted) log.info("posted late live-session replies", { channel, peer_id: peerId, count: posted });
  return posted;
}

/**
 * Drain every claimed peer that has no route polling. Driven from a tick in
 * startBridge: slack_post cannot see whether a window is open, so the daemon is
 * the only place that can deliver what the session was told it had sent.
 */
export async function drainIdleLeftovers({ broker, web, claims, log }) {
  if (!broker || !claims) return 0;
  let total = 0;
  for (const [channel, claim] of Object.entries(claims.all())) {
    if (!claim?.peer_id || activeRoutes.has(claim.peer_id)) continue;
    total += await drainLeftoverReplies({ broker, web, channel, threadTs: null, peerId: claim.peer_id, log });
  }
  return total;
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

  // A reply sent outside a live window has no poller. Drain claimed peers on a
  // tick so it is posted rather than destroyed by the next route's pre-send drain.
  if (remote?.broker && remote?.claims) {
    const drainTimer = setInterval(() => {
      drainIdleLeftovers({ broker: remote.broker, web, claims: remote.claims, log }).catch(() => {});
    }, 30_000);
    drainTimer.unref?.();
  }

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
