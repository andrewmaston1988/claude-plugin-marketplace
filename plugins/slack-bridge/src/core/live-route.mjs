import { mdToSlack } from "../markdown/index.mjs";
import { startHeartbeat } from "../heartbeat/loop.mjs";
import { isConnectionError } from "../remote/broker-client.mjs";
import { WAIT_WINDOW_MS } from "../remote/wait-constants.mjs";
import { postResponse, postError } from "./reply-post.mjs";

// routeToLiveSession returns once the message is handed to the broker — the channel
// queue is never held across the reply; the daemon reply loop resolves the window.

// A reply arrives as several broker messages when the session posts in chunks.
// The window keeps collecting until the session goes quiet, so the whole reply
// lands in one window, in order.
const QUIET_GAP_MS = 1_000;

const routeWindows = new Map();  // peer_id → open windows, oldest first
const statusLines = new Map();   // channel → ts of its in-place status line
// Peers sitting on an AskUserQuestion dialog: they can't reply until the operator
// answers it, so windows opened meanwhile hold their timeout until the peer moves.
const pendingQuestion = new Set();

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
  pendingQuestion.clear();
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

  if (!pendingQuestion.has(peerId)) armTimeout(window);
  return window;
}

// The window's own deadline. Nothing else posts on its behalf: the reply loop
// only ever sees a window that is still open.
function armTimeout(window) {
  window.timeoutTimer = setTimeout(() => { void finalizeWindow(window, { timeout: true }); },
    window.config.remote?.replyTimeoutMs ?? 300_000);
  window.timeoutTimer.unref?.();
}

// Any later message means the dialog was answered: arm the windows it held.
function releaseQuestion(peerId) {
  if (!pendingQuestion.delete(peerId)) return;
  for (const w of routeWindows.get(peerId) ?? []) {
    if (!w.done && !w.chunks.length && !w.timeoutTimer) armTimeout(w);
  }
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
 * or question reply resolves the newest open window (abandoning older ones), or posts directly
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

  if (message.kind === "question") pendingQuestion.add(fromId);
  else releaseQuestion(fromId);

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
