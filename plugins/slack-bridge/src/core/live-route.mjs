import { mdToSlack } from "../markdown/index.mjs";
import { startHeartbeat } from "../heartbeat/loop.mjs";
import { isConnectionError } from "../remote/broker-client.mjs";
import { WAIT_WINDOW_MS } from "../remote/wait-constants.mjs";
import { postResponse, postError } from "./reply-post.mjs";
import { postTerminalPrompt } from "./prompt-post.mjs";
import { addUnread, takeUnread, clearUnread, resetUnread, hasUnread, statusLine, showStatus } from "./route-status.mjs";

// routeToLiveSession returns once the message is handed to the broker — the channel
// queue is never held across the reply; the daemon reply loop resolves the window.

// A reply arrives as several broker messages when the session posts in chunks.
// The window keeps collecting until the session goes quiet, so the whole reply
// lands in one window, in order.
const QUIET_GAP_MS = 1_000;

// How long a turn-end is remembered: a tool-start hook sends within seconds of starting.
const TURN_END_MEMORY_MS = 60_000;

const routeWindows = new Map();  // peer_id → open windows, oldest first
// One placeholder-post in flight per peer: status messages arrive in parallel, and
// two that both found no window must not post two blocks.
const openingWindows = new Map();  // peer_id → in-flight openWorkingWindow promise
const lastClosedAt = new Map();    // peer_id → ms its turn last ended
// Off routeWindows while its reply posts, but a turn-end landing then still ends its turn.
const postingReplies = new Set();

/** Test hook: drop window/status state between cases. */
export function _resetRouteState() {
  for (const windows of routeWindows.values()) {
    for (const w of windows) {
      clearTimeout(w.quietTimer);
      w.done = true;
    }
  }
  routeWindows.clear();
  openingWindows.clear();
  postingReplies.clear();
  lastClosedAt.clear();
  resetUnread();
}

/** Test hook: the close marks, so a case can age one. */
export function _closedMarks() { return lastClosedAt; }

// Marks the end of a peer's turn, for the late-status check and the reopen. Never
// backwards: hooks land out of order. Prune on write: one entry per peer would
// otherwise live as long as the daemon.
function markClosed(peerId, at = Date.now()) {
  lastClosedAt.set(peerId, Math.max(at, lastClosedAt.get(peerId) ?? at));
  const now = Date.now();
  for (const [id, mark] of lastClosedAt) {
    if (now - mark >= TURN_END_MEMORY_MS) lastClosedAt.delete(id);
  }
}

// Async hooks can outlast their turn: one that started before the peer's last
// turn-end belongs to the finished turn. A message from hooks too old to stamp it
// is never late.
function startedBeforeTurnEnd(peerId, message) {
  const endedAt = lastClosedAt.get(peerId);
  return endedAt !== undefined && Number.isFinite(message?.hook_started_at) && message.hook_started_at < endedAt;
}

function removeWindow(window) {
  const windows = routeWindows.get(window.peerId);
  if (!windows) return;
  const i = windows.indexOf(window);
  if (i >= 0) windows.splice(i, 1);
  if (!windows.length) routeWindows.delete(window.peerId);
}

function openRouteWindow({ web, peerId, channel, threadTs, placeholderTs, startedAt, heartbeat, startHeartbeat, cmdEcho, config, log, terminal = false, lastStatus = null }) {
  const window = {
    web, peerId, channel, threadTs, placeholderTs, startedAt, heartbeat, startHeartbeat, cmdEcho, config, log, terminal, lastStatus,
    chunks: [], moreComing: false, deliveryWaiters: [], done: false, quietTimer: null,
  };
  const windows = routeWindows.get(peerId) ?? [];
  windows.push(window);
  routeWindows.set(peerId, windows);
  return window;
}

/**
 * Close a window: stop the heartbeat, then post its reply (or the send-failure
 * error) into the placeholder. The heartbeat is stopped and joined BEFORE the
 * reply lands in every branch — the .py canon: a final tick's
 * chatUpdate(text:"") otherwise clobbers the reply body.
 */
async function finalizeWindow(window, { errorMessage = null } = {}) {
  if (window.done) return false;
  window.done = true;
  clearTimeout(window.quietTimer);
  removeWindow(window);
  postingReplies.add(window);

  const { web, channel, threadTs, placeholderTs, heartbeat, cmdEcho, config, log, chunks } = window;
  let delivered = false;
  let replied = false;
  const deliveryOutcomes = [];
  try {
    await heartbeat?.stop();
    if (errorMessage) {
      await postError({ web, channel, placeholderTs, threadTs, message: errorMessage });
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
      replied = true;
    }
  } catch (e) {
    log.error("failed to post live-session reply", { channel, error: e.message });
    try {
      await postError({ web, channel, placeholderTs: null, threadTs, message: `live session reply post failed: ${e.message}` });
    } catch {}
  } finally {
    postingReplies.delete(window);
    for (const { resolve, chunkIndex } of window.deliveryWaiters.splice(0)) resolve(deliveryOutcomes[chunkIndex] === true);
  }
  if (replied) await reopenUnderReply(window);
  return delivered;
}

// A reply takes the block it lands in, so one goes back under it while the session
// is still going. A queued message outlives the turn, so that block stays for the
// answer; otherwise it is the turn's, and goes at turn-end.
async function reopenUnderReply(window) {
  const { web, peerId, channel, threadTs, config, log, startHeartbeat: _startHeartbeat } = window;
  // Already a block at the bottom, or no turn follows to fill one.
  if (window.final || routeWindows.get(peerId)?.length) return;
  const unread = hasUnread(peerId);
  if (!unread && !window.moreComing) return;
  await openWorkingWindowOnce({
    web, peerId, channel, threadTs, config, log, _startHeartbeat, terminal: !unread, from: window,
  });
}

// Close a peer's windows without posting: heartbeat stopped, placeholder deleted. They
// are detached before the first await, so a message dispatched beside this one finds
// the turn over. A final close keeps the unread count for the read still to come.
async function closeWindows(peerId, { terminalOnly = false, at, final = false, only = null } = {}) {
  markClosed(peerId, at);
  if (!terminalOnly && !final) clearUnread(peerId);
  const closing = [];
  const posting = only ? [] : [...postingReplies].filter((w) => w.peerId === peerId);
  for (const w of [...(only ? [only] : routeWindows.get(peerId) ?? []), ...posting]) {
    w.moreComing = false;
    w.final ||= final;
    if (w.done || (terminalOnly && !w.terminal)) continue;
    // A turn-end races the quiet gap: the answer is already in this window and
    // its timer will post it. Deleting is for a block with nothing to say.
    if (w.chunks.length) continue;
    w.done = true;
    clearTimeout(w.quietTimer);
    removeWindow(w);
    for (const { resolve } of w.deliveryWaiters.splice(0)) resolve(false);
    closing.push(w);
  }
  for (const w of closing) {
    try {
      await w.heartbeat?.stop();
      await w.web.chatDelete({ channel: w.channel, ts: w.placeholderTs });
    } catch (e) {
      w.log.warn("placeholder delete failed", { channel: w.channel, error: e.message });
    }
  }
}

/** Close a peer's windows, including a placeholder that was posting when this began. */
export async function closePeerWindows(peerId, opts = {}) {
  const posting = openingWindows.get(peerId);
  const at = opts.at ?? Date.now();
  const closed = closeWindows(peerId, { ...opts, at });
  // A failed placeholder open leaves no window to close.
  const late = await posting?.catch(() => null);
  await closed;
  if (late) await closeWindows(peerId, { ...opts, at, only: late });
}

// The window a reply or status belongs to: one already collecting a reply keeps
// it; otherwise the newest, so the reply lands at the bottom of the channel.
function targetWindow(peerId) {
  const windows = routeWindows.get(peerId);
  if (!windows?.length) return null;
  return windows.find((w) => w.chunks.length) ?? windows[windows.length - 1];
}

// One session turn answers everything queued, so placeholders older than the one
// the reply lands in will never get their own answer — delete them. A new Slack
// message does the same, so the live block stays under the last message. A block
// already holding a reply stays: its quiet gap posts it.
async function abandonOlderWindows(target) {
  const windows = routeWindows.get(target.peerId) ?? [];
  for (const w of windows.slice(0, windows.indexOf(target))) {
    if (w.chunks.length) continue;
    w.done = true;
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

// The grey `_Working…_` block and its heartbeat, for every turn shape that shows
// one. Null when the placeholder could not be posted.
async function openWorkingWindow({
  web, peerId, channel, threadTs = null, config, log, cmdEcho = "", prompt = null,
  _startHeartbeat = startHeartbeat, terminal = false, from = null,
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

  // A block taking over from an older one keeps its clock and tool line: the
  // session has been working since then. A block holding a reply is only that
  // when the reopen says so.
  const previous = from ?? routeWindows.get(peerId)?.find((w) => !w.chunks.length);
  const startedAt = previous?.startedAt ?? Date.now();

  // The spawn path's heartbeat minus extensions (their snippet describes spawned
  // sessions) and minus the echo: the operator's message is already right above.
  const heartbeat = _startHeartbeat({
    startedAt, web, channel, ts: placeholderTs, cmdEcho: "", log: log.child("heartbeat"),
    extensions: null, sessionId: peerId, config,
  });
  if (prompt && config.slack?.verbMode === "haiku") {
    heartbeat.setTool("working", { prompt: prompt.slice(0, 80) });
  }

  const window = openRouteWindow({
    web, peerId, channel, threadTs, placeholderTs, startedAt, heartbeat, startHeartbeat: _startHeartbeat, cmdEcho, config, log, terminal,
    lastStatus: previous?.lastStatus ?? null,
  });
  if (statusLine(window)) showStatus(window);
  return window;
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

// Route a claimed channel's message to its live session. Its block ticks for as long
// as the turn runs: slow is not dead.
export async function routeToLiveSession({
  web, channel, threadTs, text, claim, broker, config, log, cmdEcho,
  _startHeartbeat = startHeartbeat,
}) {
  // Ahead of the open: a turn-end during it must not take this message's block.
  addUnread(claim.peer_id);
  // An open already in flight lands first, so abandonOlderWindows can take it; this
  // one then registers as in flight, so a status arriving meanwhile waits for it.
  while (openingWindows.has(claim.peer_id)) await openingWindows.get(claim.peer_id).catch(() => {});
  const window = await openWorkingWindowOnce({
    web, peerId: claim.peer_id, channel, threadTs, config, log, cmdEcho, prompt: text, _startHeartbeat,
  });
  if (!window) {
    takeUnread(claim.peer_id);
    return;
  }
  await abandonOlderWindows(window);

  try {
    const r = await broker.sendMessage("slack-bridge", claim.peer_id, text);
    if (r && r.ok === false) throw new Error(r.error ?? "send failed");
  } catch (e) {
    log.error("failed to route to live session", { channel, error: e.message });
    takeUnread(claim.peer_id);
    await finalizeWindow(window, { errorMessage: `failed to route to live session: ${e.message}` });
  }
  // Return here: the queue is released and the next Slack message is its own turn.
}

// One claim per peer, so its entry is the peer's channel.
const claimChannel = (claims, peerId) => Object.entries(claims.all()).find(([, c]) => c?.peer_id === peerId)?.[0] ?? null;

// One broker message from the daemon peer to its claim channel. A message from a
// peer with no claim has nowhere to go and is dropped with a log.
async function handleBrokerMessage({ message, claims, web, config, log, _quietGapMs = QUIET_GAP_MS, _startHeartbeat = startHeartbeat }) {
  const fromId = message?.from_id;
  // Ahead of the claim lookup: unacked, a read would come back on every lease.
  if (message?.kind === "read") {
    takeUnread(fromId);
    const window = targetWindow(fromId);
    if (!window) return true;
    // The session is on the message, so a reply already here is not its last word.
    if (window.chunks.length) window.moreComing = true;
    return true;
  }
  const channel = claimChannel(claims, fromId);
  if (!channel) {
    log.warn("reply dropped: no claim for peer", { peer_id: fromId });
    return true; // acked: unacked, it would come back on every lease for a day
  }
  const text = String(message?.text ?? "");

  if (message.kind === "turn-end") {
    // An unread message outlives a Stop: its waiter takes it, and the next turn answers
    // in its block. A turn-end with a reason starts no waiter, so every block goes.
    const at = Number.isFinite(message.hook_started_at) ? message.hook_started_at : undefined;
    const final = text !== "";
    await closePeerWindows(fromId, { terminalOnly: !final && hasUnread(fromId), final, at });
    return true;
  }

  if (message.kind === "prompt") {
    if (!text || !(await postTerminalPrompt({ web, channel, text, config, log }))) return false;
    // Checked after each await: a turn-end landing during one leaves no turn to show.
    if (startedBeforeTurnEnd(fromId, message)) return true;
    // A typed prompt starts a turn, so its block goes under it. A block left by an
    // interrupted turn, with no reply in it, is over; an unread message's block moves
    // down, still not terminal; a reply in its quiet gap posts where it is.
    await closePeerWindows(fromId, { terminalOnly: hasUnread(fromId), at: message.hook_started_at });
    if (startedBeforeTurnEnd(fromId, message)) return true;
    const opened = await openWorkingWindowOnce({
      web, peerId: fromId, channel, config, log, _startHeartbeat, terminal: !hasUnread(fromId),
    });
    if (opened && !opened.done) await abandonOlderWindows(opened);
    return true;
  }

  const window = targetWindow(fromId);
  if (message.kind === "status") {
    if (!text) return false;
    const late = startedBeforeTurnEnd(fromId, message);
    if (window) {
      window.lastStatus = text;
      if (window.chunks.length && !late) window.moreComing = true;
      showStatus(window);
      return true;
    }
    // Opening here would leave a block no turn-end is left to close.
    if (late) return true;
    const opened = await openWorkingWindowOnce({
      web, peerId: fromId, channel, config, log, _startHeartbeat, terminal: true,
    });
    if (!opened) return false;
    if (opened.done) return true;
    opened.lastStatus = text;
    showStatus(opened);
    return true;
  }

  if (window) {
    // Push before the await: a turn-end dispatched in the same batch checks
    // chunks.length, and a yield here would let it delete the block this lands in.
    window.chunks.push(text);
    const chunkIndex = window.chunks.length - 1;
    if (chunkIndex === 0) await abandonOlderWindows(window);
    // Restart the quiet gap: finalise once the session has stopped sending.
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
