import { mdToSlack } from "../markdown/index.mjs";
import { startHeartbeat } from "../heartbeat/loop.mjs";
import { isConnectionError } from "../remote/broker-client.mjs";
import { WAIT_WINDOW_MS } from "../remote/wait-constants.mjs";
import { postResponse, postError, safeUpdate } from "./reply-post.mjs";

// routeToLiveSession returns once the message is handed to the broker — the channel
// queue is never held across the reply; the daemon reply loop resolves the window.

// A reply arrives as several broker messages when the session posts in chunks.
// The window keeps collecting until the session goes quiet, so the whole reply
// lands in one window, in order.
const QUIET_GAP_MS = 1_000;

// A status with no window is a PostToolUse line that lost the race with the reply
// or the turn-end that closed it. Late by that little means stale, not news.
const LATE_STATUS_MS = 5_000;

const routeWindows = new Map();  // peer_id → open windows, oldest first
// Peers sitting on an AskUserQuestion dialog: they can't reply until the operator
// answers it, so windows opened meanwhile hold their timeout until the peer moves.
const pendingQuestion = new Set();
// One placeholder-post in flight per peer: status messages arrive in parallel, and
// two that both found no window must not post two blocks.
const openingWindows = new Map();  // peer_id → in-flight openWorkingWindow promise
const lastClosedAt = new Map();    // peer_id → ms its last window closed

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
  pendingQuestion.clear();
  openingWindows.clear();
  lastClosedAt.clear();
}

function removeWindow(window) {
  const windows = routeWindows.get(window.peerId);
  if (!windows) return;
  const i = windows.indexOf(window);
  if (i >= 0) windows.splice(i, 1);
  if (!windows.length) routeWindows.delete(window.peerId);
}

function openRouteWindow({ web, peerId, channel, threadTs, placeholderTs, heartbeat, cmdEcho, config, log, terminal = false }) {
  const window = {
    web, peerId, channel, threadTs, placeholderTs, heartbeat, cmdEcho, config, log, terminal,
    chunks: [], deliveryWaiters: [], done: false, timeoutTimer: null, quietTimer: null,
  };
  const windows = routeWindows.get(peerId) ?? [];
  windows.push(window);
  routeWindows.set(peerId, windows);

  window.held = pendingQuestion.has(peerId);
  armTimeout(window);
  return window;
}

// A held window still gets a ceiling: a peer that dies on the dialog never moves.
const HELD_CEILING_FACTOR = 12;

// What the deadline becomes. It is not an error: the session is slow, and the
// message is still queued behind whatever it is doing.
export const SOFT_TIMEOUT_TEXT = "Still working. Your message is queued and arrives when the current turn ends.";

export function noReplyText(ceilingMs) {
  return `No reply after ${Math.max(1, Math.round(ceilingMs / 60_000))}m. Your message stays queued.`;
}

// The soft deadline, then the ceiling behind it. A held or terminal window has no
// message to time out, so it arms the ceiling directly.
function armTimeout(window) {
  const ms = window.config.remote?.replyTimeoutMs ?? 300_000;
  if (window.terminal || window.held) {
    armCeiling(window, HELD_CEILING_FACTOR * ms);
    return;
  }
  window.timeoutTimer = setTimeout(() => {
    window.heartbeat?.setStatus?.(SOFT_TIMEOUT_TEXT);
    armCeiling(window, (HELD_CEILING_FACTOR - 1) * ms, HELD_CEILING_FACTOR * ms);
  }, ms);
  window.timeoutTimer.unref?.();
}

function armCeiling(window, remainingMs, totalMs = remainingMs) {
  window.timeoutTimer = setTimeout(() => {
    // A terminal window has no queued message to explain: it just goes, exactly
    // as it would at turn-end.
    if (window.terminal) { void closeWindows(window.peerId, { terminalOnly: true }); return; }
    void finalizeWindow(window, { timeout: true, notice: noReplyText(totalMs) });
  }, remainingMs);
  window.timeoutTimer.unref?.();
}

// Any later message means the dialog was answered: re-arm the windows it held.
function releaseQuestion(peerId) {
  if (!pendingQuestion.delete(peerId)) return;
  for (const w of routeWindows.get(peerId) ?? []) {
    if (w.done || w.chunks.length || !w.held) continue;
    clearTimeout(w.timeoutTimer);
    w.held = false;
    armTimeout(w);
  }
}

/**
 * Close a window: stop the heartbeat, then post its reply (or the timeout /
 * send-failure error) into the placeholder. The heartbeat is stopped and joined
 * BEFORE the reply lands in every branch — the .py canon: a final tick's
 * chatUpdate(text:"") otherwise clobbers the reply body.
 */
async function finalizeWindow(window, { timeout = false, errorMessage = null, notice = null } = {}) {
  if (window.done) return false;
  window.done = true;
  clearTimeout(window.timeoutTimer);
  clearTimeout(window.quietTimer);
  removeWindow(window);
  lastClosedAt.set(window.peerId, Date.now());

  const { web, channel, threadTs, placeholderTs, heartbeat, cmdEcho, config, log, chunks } = window;
  let delivered = false;
  const deliveryOutcomes = [];
  try {
    await heartbeat?.stop();
    if (notice) {
      // The ceiling is a close, not a failure: no `_Error:` wrapper, no attachment.
      await safeUpdate({ web, channel, ts: placeholderTs, threadTs, params: { text: notice, attachments: [] } });
      delivered = true;
    } else if (timeout || chunks.length === 0) {
      await postError({
        web, channel, placeholderTs, threadTs,
        message: errorMessage ?? "live session didn't reply in time",
      });
      delivered = true;
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
          delivered = true;
          deliveryOutcomes[i] = true;
        } else {
          const postParams = { channel, text: mdToSlack(chunks[i]) };
          if (threadTs) postParams.thread_ts = threadTs;
          await web.chatPostMessage(postParams);
          delivered = true;
          deliveryOutcomes[i] = true;
        }
      }
    }
  } catch (e) {
    log.error("failed to post live-session reply", { channel, error: e.message });
    try {
      await postError({ web, channel, placeholderTs: null, threadTs, message: `live session reply post failed: ${e.message}` });
    } catch {}
  } finally {
    for (const { resolve, chunkIndex } of window.deliveryWaiters.splice(0)) resolve(deliveryOutcomes[chunkIndex] === true);
  }
  return delivered;
}

/**
 * Close a peer's windows without posting anything: heartbeat stopped, placeholder
 * deleted. Used when the peer leaves (turn-end) or is gone (a disconnect), where
 * finalizeWindow would write text about a message nobody is going to answer.
 */
async function closeWindows(peerId, { terminalOnly = false } = {}) {
  for (const w of [...(routeWindows.get(peerId) ?? [])]) {
    if (terminalOnly && !w.terminal) continue;
    w.done = true;
    clearTimeout(w.timeoutTimer);
    clearTimeout(w.quietTimer);
    removeWindow(w);
    lastClosedAt.set(peerId, Date.now());
    for (const { resolve } of w.deliveryWaiters.splice(0)) resolve(false);
    try {
      await w.heartbeat?.stop();
      await w.web.chatDelete({ channel: w.channel, ts: w.placeholderTs });
    } catch (e) {
      w.log.warn("placeholder delete failed", { channel: w.channel, error: e.message });
    }
  }
}

/** Close every window a peer has open — the daemon uses this when the peer dies. */
export async function closePeerWindows(peerId) {
  return closeWindows(peerId);
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
    lastClosedAt.set(target.peerId, Date.now());
    try {
      await w.heartbeat?.stop();
      await w.web.chatDelete({ channel: w.channel, ts: w.placeholderTs });
    } catch (e) {
      w.log.warn("abandoned placeholder delete failed", { channel: w.channel, error: e.message });
    }
  }
}

/**
 * Post the grey `_Working…_` block and start its heartbeat, then register the
 * window. Shared by every turn shape that shows a block: a routed Slack message,
 * a typed prompt at the terminal, and a tool status with no window already open.
 * Returns null when the placeholder could not be posted.
 */
async function openWorkingWindow({
  web, peerId, channel, threadTs = null, config, log, cmdEcho = "", prompt = null,
  _startHeartbeat = startHeartbeat, terminal = false,
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
    return null;
  }

  // The spawn path's heartbeat minus extensions (their snippet describes spawned
  // sessions) and minus the echo: the operator's message is already right above.
  const heartbeat = _startHeartbeat({
    web, channel, ts: placeholderTs, cmdEcho: "", log: log.child("heartbeat"),
    extensions: null, sessionId: peerId, config,
  });
  if (prompt && config.slack?.verbMode === "haiku") {
    heartbeat.setTool("working", { prompt: prompt.slice(0, 80) });
  }

  return openRouteWindow({ web, peerId, channel, threadTs, placeholderTs, heartbeat, cmdEcho, config, log, terminal });
}

// Status messages are dispatched in parallel, so two can both find no window.
// One post per peer in flight keeps that to a single block.
function openWorkingWindowOnce(opts) {
  const inflight = openingWindows.get(opts.peerId);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      return await openWorkingWindow(opts);
    } finally {
      if (openingWindows.get(opts.peerId) === p) openingWindows.delete(opts.peerId);
    }
  })();
  openingWindows.set(opts.peerId, p);
  return p;
}

/**
 * Route a claimed channel's message to its live session: placeholder + heartbeat,
 * hand it to the broker, register the window, return. The reply loop resolves the
 * window when the session answers; the window's own timers soften the deadline and
 * then close it at the ceiling. The claim is retained either way — slow is not dead.
 */
export async function routeToLiveSession({
  web, channel, threadTs, text, claim, broker, config, log, cmdEcho,
  _startHeartbeat = startHeartbeat,
}) {
  const window = await openWorkingWindow({
    web, peerId: claim.peer_id, channel, threadTs, config, log, cmdEcho, prompt: text, _startHeartbeat,
  });
  if (!window) return;

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
 * One broker message from the daemon peer → its claim channel.
 *
 *   status    → into the open window; with none, opens a terminal window.
 *   prompt    → a prompt typed at the terminal: posted to the channel under the
 *               operator's name, then a terminal window unless one is open.
 *   turn-end  → the turn is over: close the peer's terminal windows, post nothing.
 *   text / question → resolve the newest open window (abandoning older ones), or
 *               post directly when none is open.
 *
 * A message from a peer with no claim has nowhere to go and is dropped with a log.
 */
async function handleBrokerMessage({ message, claims, web, config, log, _quietGapMs = QUIET_GAP_MS, _startHeartbeat = startHeartbeat }) {
  const fromId = message?.from_id;
  // hasOwn-style lookup over the claims store: one claim per peer, so the entry
  // is the reply's destination channel.
  const entry = Object.entries(claims.all()).find(([, c]) => c?.peer_id === fromId);
  if (!entry) {
    log.warn("reply dropped: no claim for peer", { peer_id: fromId });
    return false;
  }
  const [channel] = entry;
  const text = String(message?.text ?? "");

  if (message.kind === "question") pendingQuestion.add(fromId);
  else releaseQuestion(fromId);

  if (message.kind === "turn-end") {
    await closeWindows(fromId, { terminalOnly: true });
    return true;
  }

  if (message.kind === "prompt") {
    if (!text) return false;
    const postParams = { channel, text: mdToSlack(text) };
    const name = config.remote?.operatorName ?? null;
    const icon = config.remote?.operatorIconUrl ?? null;
    if (name) postParams.username = name;
    if (icon) postParams.icon_url = icon;
    // No custom identity to post under: mark it as typed somewhere else, so it
    // reads as the operator's terminal rather than as the bot talking to itself.
    if (!name && !icon) postParams.text = `⌨️ ${text}`;
    try {
      await web.chatPostMessage(postParams);
    } catch (e) {
      log.warn("failed to post terminal prompt", { channel, error: e.message });
      return false;
    }
    if (!targetWindow(fromId)) {
      await openWorkingWindowOnce({
        web, peerId: fromId, channel, config, log, _startHeartbeat, terminal: true,
      });
    }
    return true;
  }

  const window = targetWindow(fromId);
  if (message.kind === "status") {
    if (!text) return false;
    if (window) {
      window.heartbeat?.setStatus?.(text);
      return true;
    }
    // PostToolUse is async: a status can land after the reply or turn-end closed
    // the window it belonged to. Posting it then leaves a stale block that a
    // later reply can never resolve.
    const closedAt = lastClosedAt.get(fromId);
    if (closedAt !== undefined && Date.now() - closedAt < LATE_STATUS_MS) return true;
    const opened = await openWorkingWindowOnce({
      web, peerId: fromId, channel, config, log, _startHeartbeat, terminal: true,
    });
    if (!opened) return false;
    opened.heartbeat?.setStatus?.(text);
    return true;
  }

  if (window) {
    if (!window.chunks.length) await abandonOlderWindows(window);
    window.chunks.push(text);
    const chunkIndex = window.chunks.length - 1;
    // Restart the quiet gap: stop the window's deadline firing mid-collection,
    // then finalise once the session has stopped sending.
    clearTimeout(window.timeoutTimer);
    clearTimeout(window.quietTimer);
    // The quiet gap is the only thing that will resolve this chunk's delivery waiter,
    // so it must keep the event loop alive: unref'd, it is dropped when it is the last
    // pending work and the waiter never settles.
    window.quietTimer = setTimeout(() => { void finalizeWindow(window); }, _quietGapMs);
    return new Promise((resolve) => window.deliveryWaiters.push({ resolve, chunkIndex }));
  }

  const postParams = { channel, text: mdToSlack(text) };
  try {
    await web.chatPostMessage(postParams);
    return true;
  } catch (e) {
    log.warn("failed to post live-session reply", { channel, error: e.message });
    return false;
  }
}

// The only consumer for the daemon broker peer: long-polls /wait; connection errors back off and retry.
export function startReplyLoop({
  broker, claims, web, config, log,
  _sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  _quietGapMs = QUIET_GAP_MS,
  _startHeartbeat = startHeartbeat,
}) {
  const abort = new AbortController();
  let failures = 0;

  const done = (async () => {
    while (!abort.signal.aborted) {
      let messages;
      let ack;
      let superseded = false;
      try {
        // The client owns the deadline: a half-open socket aborts one window late
        // rather than hanging the waiter forever.
        const res = await broker.wait("slack-bridge", WAIT_WINDOW_MS, {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(WAIT_WINDOW_MS + 10_000)]),
        });
        messages = res?.messages ?? [];
        ack = res?.ack;
        superseded = res?.superseded === true;
        failures = 0;
      } catch (e) {
        if (abort.signal.aborted) break;
        failures++;
        if (!isConnectionError(e)) log.error("reply loop: broker call failed", { error: e.message });
        await _sleep(Math.min(1000 * 2 ** (failures - 1), 30_000));
        continue;
      }
      if (superseded) { await _sleep(1000); continue; }
      const successfulIds = [];
      const dispatches = messages.map((message) => handleBrokerMessage({ message, claims, web, config, log, _quietGapMs, _startHeartbeat }).then(
        (posted) => {
          if (posted === true) successfulIds.push(message.id);
          return posted === true;
        },
        (e) => { log.error("reply loop: dispatch failed", { error: e.message }); return false; },
      ));
      if (dispatches.length) {
        void Promise.all(dispatches).then(() => {
          if (successfulIds.length) return ack?.(successfulIds);
        });
      }
    }
  })();

  return {
    /** Stop at the next window boundary. */
    stop() { abort.abort(); },
    done,
  };
}
