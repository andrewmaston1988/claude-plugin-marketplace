import { runClaude } from "./claude-subprocess.mjs";
import { mdToSlack, mdToBlocks, hasTable } from "../markdown/index.mjs";
import { startHeartbeat } from "../heartbeat/loop.mjs";
import { fetchHistory } from "../history-bootstrap/index.mjs";
import { isConnectionError } from "../remote/broker-client.mjs";
import { WAIT_WINDOW_MS } from "../remote/wait-constants.mjs";

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
    // attachments must be sent explicitly: omitted, Slack keeps the heartbeat's echo.
    const params = { text: mrkdwn, attachments: progressAttachment ? [progressAttachment] : [] };
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
    await safeUpdate({ web, channel, ts: placeholderTs, threadTs, params: { text: `_Error: ${message}_`, attachments: [] } });
  } catch { /* placeholder already gone; error was already logged by the caller */ }
}

// routeToLiveSession returns once the message is handed to the broker — the channel
// queue is never held across the reply; the daemon reply loop resolves the window.

// A reply arrives as several broker messages when the session posts in chunks.
// The window keeps collecting until the session goes quiet, so the whole reply
// lands in one window, in order.
const QUIET_GAP_MS = 1_000;

const routeWindows = new Map();  // peer_id → open windows, oldest first
const statusLines = new Map();   // channel → ts of its in-place status line

/** Test hook: drop window/status state between cases. */
export function _resetRouteState() {
  for (const windows of routeWindows.values()) {
    for (const w of windows) {
      clearTimeout(w.timeoutTimer);
      clearTimeout(w.quietTimer);
      w.done = true;
    }
  }
  routeWindows.clear();
  statusLines.clear();
}

function removeWindow(window) {
  const windows = routeWindows.get(window.peerId);
  if (!windows) return;
  const i = windows.indexOf(window);
  if (i >= 0) windows.splice(i, 1);
  if (!windows.length) routeWindows.delete(window.peerId);
}

function openRouteWindow({ web, peerId, channel, threadTs, placeholderTs, heartbeat, cmdEcho, config, log }) {
  const window = {
    web, peerId, channel, threadTs, placeholderTs, heartbeat, cmdEcho, config, log,
    chunks: [], done: false, timeoutTimer: null, quietTimer: null,
  };
  const windows = routeWindows.get(peerId) ?? [];
  windows.push(window);
  routeWindows.set(peerId, windows);

  // The window's own deadline. Nothing else posts on its behalf: the reply loop
  // only ever sees a window that is still open.
  window.timeoutTimer = setTimeout(() => { void finalizeWindow(window, { timeout: true }); },
    config.remote?.replyTimeoutMs ?? 300_000);
  window.timeoutTimer.unref?.();
  return window;
}

/**
 * Close a window: stop the heartbeat, then post its reply (or the timeout /
 * send-failure error) into the placeholder. The heartbeat is stopped and joined
 * BEFORE the reply lands in every branch — the .py canon: a final tick's
 * chatUpdate(text:"") otherwise clobbers the reply body.
 */
async function finalizeWindow(window, { timeout = false, errorMessage = null } = {}) {
  if (window.done) return;
  window.done = true;
  clearTimeout(window.timeoutTimer);
  clearTimeout(window.quietTimer);
  removeWindow(window);

  const { web, channel, threadTs, placeholderTs, heartbeat, cmdEcho, config, log, chunks } = window;
  try {
    await heartbeat?.stop();
    if (timeout || chunks.length === 0) {
      await postError({
        web, channel, placeholderTs, threadTs,
        message: errorMessage ?? "live session didn't reply in time",
      });
    } else {
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          // The first chunk replaces the placeholder; the rest post after it —
          // a session replying in several chunks must not have chunks 2..N lost.
          await postResponse({
            web, channel, placeholderTs, threadTs,
            responseText: chunks[i], existingSession: window.peerId, isFirstInSession: false,
            cmdEcho, extensions: null, sessionId: null, config,
          });
        } else {
          const postParams = { channel, text: mdToSlack(chunks[i]) };
          if (threadTs) postParams.thread_ts = threadTs;
          await web.chatPostMessage(postParams);
        }
      }
    }
  } catch (e) {
    log.error("failed to post live-session reply", { channel, error: e.message });
    await postError({ web, channel, placeholderTs: null, threadTs, message: `live session reply post failed: ${e.message}` });
  } finally {
    await clearStatus({ web, channel, log });
  }
}

// The window a reply or status belongs to: one already collecting a reply keeps
// it; otherwise the newest, so the reply lands at the bottom of the channel.
function targetWindow(peerId) {
  const windows = routeWindows.get(peerId);
  if (!windows?.length) return null;
  return windows.find((w) => w.chunks.length) ?? windows[windows.length - 1];
}

// One session turn answers everything queued, so placeholders older than the one
// the reply lands in will never get their own answer — delete them.
async function abandonOlderWindows(target) {
  const windows = routeWindows.get(target.peerId) ?? [];
  for (const w of windows.slice(0, windows.indexOf(target))) {
    w.done = true;
    clearTimeout(w.timeoutTimer);
    clearTimeout(w.quietTimer);
    removeWindow(w);
    try {
      await w.heartbeat?.stop();
      await w.web.chatDelete({ channel: w.channel, ts: w.placeholderTs });
    } catch (e) {
      w.log.warn("abandoned placeholder delete failed", { channel: w.channel, error: e.message });
    }
  }
}

// Tool calls render as ONE line per channel, edited in place (the turn mirror sends
// them as kind:"status"). The next text reply finalises it, so a stale "Bash: …"
// line does not linger under the answer.
async function postStatus({ web, channel, text, log }) {
  const existing = statusLines.get(channel);
  try {
    if (existing) {
      await web.chatUpdate({ channel, ts: existing, text });
    } else {
      const posted = await web.chatPostMessage({ channel, text });
      if (posted?.ts) statusLines.set(channel, posted.ts);
    }
  } catch (e) {
    log.warn("status line update failed", { channel, error: e.message });
  }
}

async function clearStatus({ web, channel, log }) {
  const ts = statusLines.get(channel);
  if (!ts) return;
  statusLines.delete(channel);
  try {
    await web.chatDelete({ channel, ts });
  } catch (e) {
    log.warn("status line clear failed", { channel, error: e.message });
  }
}

/**
 * Route a claimed channel's message to its live session: placeholder + heartbeat,
 * hand it to the broker, register the window, return. The reply loop resolves the
 * window when the session answers; the window's own timer posts "didn't reply in
 * time" if it never does. The claim is retained either way — slow is not dead.
 */
export async function routeToLiveSession({
  web, channel, threadTs, text, claim, broker, config, log, cmdEcho,
  _startHeartbeat = startHeartbeat,
}) {
  let placeholderTs = null;
  try {
    const postParams = {
      channel,
      text: "",
      attachments: [{ color: "#808080", text: "_Working…_", mrkdwn_in: ["text"] }],
    };
    if (threadTs) postParams.thread_ts = threadTs;
    const posted = await web.chatPostMessage(postParams);
    placeholderTs = posted.ts;
  } catch (e) {
    log.error("failed to post routed placeholder", { channel, error: e.message });
    return;
  }

  // The spawn path's heartbeat minus extensions (their snippet describes spawned
  // sessions) and minus the echo: the operator's message is already right above.
  const heartbeat = _startHeartbeat({
    web, channel, ts: placeholderTs, cmdEcho: "", log: log.child("heartbeat"),
    extensions: null, sessionId: claim.peer_id, config,
  });
  if (config.slack?.verbMode === "haiku") {
    heartbeat.setTool("working", { prompt: text.slice(0, 80) });
  }

  const window = openRouteWindow({ web, peerId: claim.peer_id, channel, threadTs, placeholderTs, heartbeat, cmdEcho, config, log });

  try {
    const r = await broker.sendMessage("slack-bridge", claim.peer_id, text);
    if (r && r.ok === false) throw new Error(r.error ?? "send failed");
  } catch (e) {
    log.error("failed to route to live session", { channel, error: e.message });
    await finalizeWindow(window, { timeout: true, errorMessage: `failed to route to live session: ${e.message}` });
  }
  // Return here: the queue is released and the next Slack message is its own turn.
}

/**
 * One broker message from the daemon peer → its claim channel. kind:"status" shows
 * in the open window's placeholder, else on the channel's one status line; a text
 * reply resolves the newest open window (abandoning older ones), or posts directly
 * when none is open. A message from a peer
 * with no claim has nowhere to go and is dropped with a log.
 */
async function handleBrokerMessage({ message, claims, web, config, log }) {
  const fromId = message?.from_id;
  // hasOwn-style lookup over the claims store: one claim per peer, so the entry
  // is the reply's destination channel.
  const entry = Object.entries(claims.all()).find(([, c]) => c?.peer_id === fromId);
  if (!entry) {
    log.warn("reply dropped: no claim for peer", { peer_id: fromId });
    return;
  }
  const [channel] = entry;
  const text = String(message?.text ?? "");

  const window = targetWindow(fromId);
  if (message.kind === "status") {
    if (!text) return;
    if (window) window.heartbeat?.setStatus?.(text);
    else await postStatus({ web, channel, text, log });
    return;
  }

  if (window) {
    if (!window.chunks.length) await abandonOlderWindows(window);
    window.chunks.push(text);
    // Restart the quiet gap: stop the window's deadline firing mid-collection,
    // then finalise once the session has stopped sending.
    clearTimeout(window.timeoutTimer);
    clearTimeout(window.quietTimer);
    window.quietTimer = setTimeout(() => { void finalizeWindow(window); }, QUIET_GAP_MS);
    window.quietTimer.unref?.();
    return;
  }

  await clearStatus({ web, channel, log });
  const postParams = { channel, text: mdToSlack(text) };
  try {
    await web.chatPostMessage(postParams);
  } catch (e) {
    log.warn("failed to post live-session reply", { channel, error: e.message });
  }
}

// The only consumer for the daemon broker peer: long-polls /wait; connection errors back off and retry.
export function startReplyLoop({
  broker, claims, web, config, log,
  _sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const abort = new AbortController();
  let failures = 0;

  const done = (async () => {
    while (!abort.signal.aborted) {
      let messages;
      try {
        // The client owns the deadline: a half-open socket aborts one window late
        // rather than hanging the waiter forever.
        const res = await broker.wait("slack-bridge", WAIT_WINDOW_MS, {
          signal: AbortSignal.timeout(WAIT_WINDOW_MS + 10_000),
        });
        messages = res?.messages ?? [];
        failures = 0;
      } catch (e) {
        if (abort.signal.aborted) break;
        failures++;
        if (!isConnectionError(e)) log.error("reply loop: broker call failed", { error: e.message });
        await _sleep(Math.min(1000 * 2 ** (failures - 1), 30_000));
        continue;
      }
      for (const message of messages) {
        try {
          await handleBrokerMessage({ message, claims, web, config, log });
        } catch (e) {
          log.error("reply loop: dispatch failed", { error: e.message });
        }
      }
    }
  })();

  return {
    /** Stop at the next window boundary. */
    stop() { abort.abort(); },
    done,
  };
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
