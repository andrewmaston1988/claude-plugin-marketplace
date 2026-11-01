// Integration: the routing branch in handleMessage and the daemon reply loop,
// against a fake broker, fake web and injected runClaude/heartbeat.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleMessage, startReplyLoop, _resetRouteState, _closedMarks } from "../../src/core/handler.mjs";
import { createQueue } from "../../src/core/queue.mjs";
import { createClaimsStore } from "../../src/remote/claims.mjs";

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
function tmpClaims() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "route-claims-")), "claims.json"); }

function makeLog() {
  const entries = [];
  const log = {
    info: (...a) => entries.push(["info", ...a]),
    warn: (...a) => entries.push(["warn", ...a]),
    error: (...a) => entries.push(["error", ...a]),
    child: () => log,
    entries,
  };
  return log;
}
function makeStore(initial = {}) {
  const data = { ...initial };
  return { get: (k) => data[k], set: (k, v) => { data[k] = v; }, delete: (k) => { delete data[k]; }, all: () => ({ ...data }) };
}
// Every placeholder gets its own ts so a test can tell which window a reply
// resolved. `calls` is the single ordered log the heartbeat also writes to.
function makeWeb() {
  const calls = [];
  let n = 0;
  return {
    calls,
    // `_ts` is the ts Slack returns for the new message — not part of the request,
    // but a test has to know which message a later chat.update targeted.
    chatPostMessage: async (p) => { const ts = `ph-${++n}`; calls.push(["post", { ...p, _ts: ts }]); return { ts, ok: true }; },
    chatUpdate: async (p) => { calls.push(["update", p]); return {}; },
    chatDelete: async (p) => { calls.push(["delete", p]); return {}; },
    authTest: async () => ({ user_id: "U123", team_id: "T1" }),
  };
}
function makeRunClaude(result = "spawn-mode reply") {
  const calls = [];
  const fn = (opts) => { calls.push(opts); return Promise.resolve({ result, sessionId: "s1" }); };
  return { fn, calls };
}
// Injected heartbeat: records start/setTool/stop into the same ordered log as the
// web calls, so "heartbeat stopped before the reply landed" is an index compare.
function makeHeartbeat(calls) {
  const instances = [];
  function start({ channel, ts, cmdEcho, extensions }) {
    const rec = { channel, ts, cmdEcho, extensions, tools: [], statuses: [], stopped: false, stopCalls: 0 };
    instances.push(rec);
    calls.push(["hb-start", rec]);
    return {
      setTool(tool, input) { rec.tools.push([tool, input]); },
      setStatus(text) { rec.statuses.push(text); },
      stop() { rec.stopped = true; rec.stopCalls++; calls.push(["hb-stop", rec]); return Promise.resolve(); },
    };
  }
  return { start, instances };
}

// Fake broker client: in-memory, no HTTP. `deliver` pushes a message addressed to
// the daemon peer; the loop's open `wait` takes it (or it queues until one opens).
function makeFakeBroker({ alive = new Set(), failWaits = 0, down = false } = {}) {
  const sendCalls = [];
  const acked = [];
  const inbox = new Map();     // peerId → queued messages
  const waiters = new Map();   // peerId → resolve fn
  let failures = failWaits;
  const ack = (ids) => { acked.push(...ids); return Promise.resolve(); };
  const broker = {
    sendCalls,
    acked,
    waitCalls: 0,
    async isAlive(peerId) { if (down) throw new TypeError("fetch failed"); return alive.has(peerId); },
    async sendMessage(fromId, toId, text) { sendCalls.push({ from_id: fromId, to_id: toId, text }); return { ok: true }; },
    deliver(peerId, message) {
      const wake = waiters.get(peerId);
      if (wake) { waiters.delete(peerId); wake([message]); return; }
      if (!inbox.has(peerId)) inbox.set(peerId, []);
      inbox.get(peerId).push(message);
    },
    // One /wait response carrying several messages: the loop dispatches them in
    // parallel, which is the race the single-flight open has to survive.
    deliverAll(peerId, messages) {
      const wake = waiters.get(peerId);
      if (wake) { waiters.delete(peerId); wake(messages); return; }
      if (!inbox.has(peerId)) inbox.set(peerId, []);
      inbox.get(peerId).push(...messages);
    },
    wait(id, timeoutMs, { signal } = {}) {
      broker.waitCalls++;
      if (failures > 0) { failures--; return Promise.reject(new TypeError("fetch failed")); }
      const queued = inbox.get(id);
      if (queued?.length) return Promise.resolve({ messages: [queued.shift()], ack });
      return new Promise((resolve) => {
        // Real windows are 55 s; a test window is only long enough to interleave.
        const timer = setTimeout(() => { waiters.delete(id); resolve({ messages: [], ack }); }, Math.min(timeoutMs, 40));
        const wake = (messages) => { clearTimeout(timer); resolve({ messages, ack }); };
        waiters.set(id, wake);
        signal?.addEventListener?.("abort", () => { waiters.delete(id); clearTimeout(timer); resolve({ messages: [], ack }); });
      });
    },
  };
  return broker;
}

function makePayload({ channel, text = "", subtype, client_msg_id }) {
  return { type: "message", channel, text, subtype, client_msg_id };
}

// One routed/claimed channel with a live peer, a started reply loop, and the
// injected heartbeat — everything a routing test needs. `t.after` stops the loop.
function setup(t, { replyTimeoutMs = 3000, claims: preClaims = [], alive: aliveOverride, quietGapMs = 1000, down = false } = {}) {
  _resetRouteState();
  const claims = createClaimsStore({ path: tmpClaims() });
  for (const [peer, channel] of preClaims) claims.claim(peer, channel);
  // By default every claimed peer is live; a test passes `alive: []` to kill them.
  const alive = aliveOverride ?? preClaims.map(([peer]) => peer);
  const broker = makeFakeBroker({ alive: new Set(alive), down });
  const web = makeWeb();
  const hb = makeHeartbeat(web.calls);
  const log = makeLog();
  const config = { slack: {}, claude: { cwd: "/tmp", timeout: 1000 }, remote: { replyTimeoutMs } };
  const loop = startReplyLoop({ broker, claims, web, config, log, _sleep: async () => {}, _quietGapMs: quietGapMs, _startHeartbeat: hb.start });
  t.after(() => loop.stop());
  // ONE queue for the whole test, as the bridge has: it is the serialisation the
  // "a routed message must not hold the channel queue" case depends on.
  const queue = createQueue({ log: makeLog() });
  return { claims, broker, web, hb, log, config, loop, queue };
}

// Drive one Slack message through handleMessage with the harness wired in; the
// channel has a model picked, so the spawn fallback is reachable.
async function slack(s, payload, { runClaude, extensions = null } = {}) {
  return handleMessage({
    web: s.web, store: makeStore({ [payload.channel]: { model: "sonnet" } }), queue: s.queue, config: s.config, log: s.log,
    payload, botUserId: "U123", isFirstInSession: true,
    remote: { claims: s.claims, broker: s.broker },
    extensions, _runClaude: runClaude?.fn, _startHeartbeat: s.hb.start,
  });
}

async function waitFor(pred, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await delay(20);
  }
  throw new Error("waitFor timed out");
}
const hasPost = (web, needle) => web.calls.some(([t, p]) => t === "post" && typeof p.text === "string" && p.text.includes(needle));
// The state blocks are attachments, so a plain-text search misses them.
const posted = (web, needle) => web.calls.some(([t, p]) => t === "post"
  && (String(p.text ?? "").includes(needle)
    || (p.attachments ?? []).some((a) => String(a.text ?? "").includes(needle))));
const hasUpdate = (web, needle) => web.calls.some(([t, p]) => t === "update" && typeof p.text === "string" && p.text.includes(needle));
const idxOf = (web, pred) => web.calls.findIndex(pred);

// ── Routing: placeholder + heartbeat ─────────────────────────────────────────

test("routed message → grey placeholder without the message echo, heartbeat running; reply replaces it", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  const rc = makeRunClaude();
  await slack(s, makePayload({ channel: "C1", text: "hello from slack", client_msg_id: "m-route-1" }), { runClaude: rc });
  await waitFor(() => s.broker.sendCalls.length === 1);

  const placeholder = s.web.calls.find(([type]) => type === "post")?.[1];
  assert.ok(placeholder, "a placeholder must be posted for the routed message");
  assert.equal(placeholder.attachments?.[0]?.color, "#808080", "the placeholder is the spawn-path grey attachment");
  assert.ok(!placeholder.attachments[0].text.includes("hello from slack"), "the routed placeholder does not echo the Slack message");
  assert.ok(!/routed to live session/.test(placeholder.attachments[0].text), "the old 📱 routed caption is gone");
  assert.equal(s.hb.instances.length, 1, "one heartbeat per routed window");
  assert.equal(s.hb.instances[0].stopped, false, "the heartbeat runs while the window is open");
  assert.equal(s.hb.instances[0].ts, placeholder._ts, "the heartbeat drives the placeholder");
  assert.equal(s.hb.instances[0].cmdEcho, "", "the routed heartbeat shows verb and timer only");

  s.broker.deliver("slack-bridge", { from_id: "peerA", text: "live reply!" });
  await waitFor(() => hasUpdate(s.web, "live reply!"), 4000);

  assert.equal(rc.calls.length, 0, "runClaude must NOT be called for a claimed+live channel");
  assert.ok(
    s.broker.sendCalls.some((c) => c.from_id === "slack-bridge" && c.to_id === "peerA" && c.text === "hello from slack"),
    "must send the Slack message to the broker addressed to the claiming peer",
  );
  const replyTs = s.web.calls.find(([ty, p]) => ty === "update" && p.text?.includes("live reply!"))[1].ts;
  assert.equal(replyTs, placeholder._ts, "the reply replaces the routed placeholder in place");
});

test("routed heartbeat runs without extensions — their progress describes spawned sessions, not the live one", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  const extensions = { runHeartbeatAugment: async () => "FOREIGN_PROGRESS" };
  await slack(s, makePayload({ channel: "C1", text: "hi", client_msg_id: "m-route-ext" }), { extensions });
  await waitFor(() => s.broker.sendCalls.length === 1);
  assert.equal(s.hb.instances[0].extensions, null);
});

test("haiku verbMode → heartbeat is seeded with the Slack message as the working verb", async (t) => {
  const s = setup(t, { claims: [["peerAA", "C-verb"]] });
  s.config.slack = { verbMode: "haiku" };
  const rc = makeRunClaude();
  await slack(s, makePayload({ channel: "C-verb", text: "please check the parser", client_msg_id: "m-verb" }), { runClaude: rc });
  await waitFor(() => s.broker.sendCalls.length === 1);

  assert.deepEqual(
    s.hb.instances[0].tools,
    [["working", { prompt: "please check the parser" }]],
    "the spawn path's setTool('working', {prompt}) is mirrored on the routed path",
  );
});

test("heartbeat stops before the reply lands (no heartbeat update after the reply)", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  await slack(s, makePayload({ channel: "C1", text: "hello", client_msg_id: "m-hb-order" }));
  await waitFor(() => s.broker.sendCalls.length === 1);

  s.broker.deliver("slack-bridge", { from_id: "peerA", text: "the answer" });
  await waitFor(() => hasUpdate(s.web, "the answer"), 4000);

  assert.equal(s.hb.instances[0].stopCalls, 1, "the window's heartbeat must be stopped, and awaited");
  const stopIdx = idxOf(s.web, ([ty]) => ty === "hb-stop");
  const replyIdx = idxOf(s.web, ([ty, p]) => ty === "update" && p.text === "the answer");
  assert.ok(stopIdx >= 0 && stopIdx < replyIdx, "stop() must land before the reply update, or a heartbeat tick clobbers it");
});

// ── Soft timeout and ceiling ─────────────────────────────────────────────────

const NO_REPLY_RE = /^No reply after \d+m\. Your message stays queued\.$/;

test("at replyTimeoutMs the placeholder is NOT replaced — the status softens to 'Still working' and the heartbeat runs on", async (t) => {
  const s = setup(t, { claims: [["peerC", "C3"]], replyTimeoutMs: 200 });
  const rc = makeRunClaude();
  await slack(s, makePayload({ channel: "C3", text: "hello", client_msg_id: "m-route-4" }), { runClaude: rc });
  const placeholderTs = placeholderTss(s.web)[0];

  await waitFor(() => s.hb.instances[0].statuses.length === 1, 3000);

  assert.equal(
    s.hb.instances[0].statuses[0],
    "Still working. Your message is queued and arrives when the current turn ends.",
    "the deadline becomes a status, not an error",
  );
  assert.ok(
    !s.web.calls.some(([ty, p]) => ty === "update" && p.ts === placeholderTs && /didn't reply|_Error:|No reply after/.test(String(p.text ?? ""))),
    "the placeholder still holds the window — nothing replaced it with an error",
  );
  assert.equal(s.hb.instances[0].stopped, false, "the heartbeat keeps running past the soft notice");
  assert.equal(rc.calls.length, 0, "must not spawn on a claimed+live channel");
});

test("a reply after the soft notice lands in the original placeholder", async (t) => {
  const s = setup(t, { claims: [["peerCS", "C-soft"]], replyTimeoutMs: 200 });
  await slack(s, makePayload({ channel: "C-soft", text: "hello", client_msg_id: "m-soft-reply" }));
  const placeholderTs = placeholderTss(s.web)[0];
  await waitFor(() => s.hb.instances[0].statuses.length === 1, 3000);

  s.broker.deliver("slack-bridge", { from_id: "peerCS", text: "the late answer" });
  await waitFor(() => hasUpdate(s.web, "the late answer"), 4000);

  const reply = s.web.calls.find(([ty, p]) => ty === "update" && p.text === "the late answer")[1];
  assert.equal(reply.ts, placeholderTs, "the late reply keeps the placeholder the soft notice was showing in");
});

test("at the ceiling the window closes with the no-reply text and the claim is kept", async (t) => {
  const s = setup(t, { claims: [["peerCC", "C-ceil"]], replyTimeoutMs: 200 });
  await slack(s, makePayload({ channel: "C-ceil", text: "hello", client_msg_id: "m-ceil" }));

  await waitFor(
    () => s.web.calls.some(([ty, p]) => ty === "update" && NO_REPLY_RE.test(String(p.text ?? ""))),
    6000,
  );

  const close = s.web.calls.find(([ty, p]) => ty === "update" && NO_REPLY_RE.test(String(p.text ?? "")))[1];
  assert.equal(close.attachments?.length, 0, "the ceiling closes the block rather than wrapping an error");
  assert.ok(s.claims.get("C-ceil"), "the claim survives the ceiling — a slow peer is not a dead one");
  assert.equal(s.hb.instances[0].stopped, true, "the heartbeat stops at the ceiling");
});

test("send failure → error posted, heartbeat stopped, no window left open", async (t) => {
  const s = setup(t, { claims: [["peerS", "C-S"]] });
  s.broker.sendMessage = async () => ({ ok: false, error: "peer gone" });
  await slack(s, makePayload({ channel: "C-S", text: "hello", client_msg_id: "m-send-fail" }));

  await waitFor(() => hasUpdate(s.web, "failed to route"), 3000);
  assert.equal(s.hb.instances[0].stopped, true, "the send-failure branch stops the heartbeat");
});

test("three chunks in quick succession → all three posted, in order, in the same window", async (t) => {
  const s = setup(t, { claims: [["peerD", "C4"]] });
  await slack(s, makePayload({ channel: "C4", text: "hello", client_msg_id: "m-route-5" }));
  await waitFor(() => s.broker.sendCalls.length === 1);

  // A session replying in several chunks: all arrive inside the window's 1 s
  // quiet gap, so they resolve the ONE oldest window rather than being split
  // across windows or dropped.
  s.broker.deliver("slack-bridge", { from_id: "peerD", text: "chunk one" });
  s.broker.deliver("slack-bridge", { from_id: "peerD", text: "chunk two" });
  s.broker.deliver("slack-bridge", { from_id: "peerD", text: "chunk three" });

  await waitFor(() => hasPost(s.web, "chunk three"), 4000);
  const i1 = idxOf(s.web, ([ty, p]) => ty === "update" && p.text === "chunk one");
  const i2 = idxOf(s.web, ([ty, p]) => ty === "post" && p.text === "chunk two");
  const i3 = idxOf(s.web, ([ty, p]) => ty === "post" && p.text === "chunk three");
  assert.ok(i1 >= 0, "the first chunk replaces the routed placeholder");
  assert.ok(i1 < i2 && i2 < i3, "the remaining chunks post after it, in order");
});

test("chunks after the first → converted to Slack mrkdwn like the first", async (t) => {
  const s = setup(t, { claims: [["peerD", "C4"]] });
  await slack(s, makePayload({ channel: "C4", text: "hello", client_msg_id: "m-route-md" }));
  await waitFor(() => s.broker.sendCalls.length === 1);
  s.broker.deliver("slack-bridge", { from_id: "peerD", text: "first" });
  s.broker.deliver("slack-bridge", { from_id: "peerD", text: "**Your move:** pick" });

  await waitFor(() => hasPost(s.web, "pick"), 4000);
  assert.ok(hasPost(s.web, "*Your move:* pick"), "**bold** in a later chunk must become *bold*");
});

// ── Daemon reply loop ────────────────────────────────────────────────────────
// One consumer for the daemon peer: slack_post (or the turn mirror) reaches the
// channel through this loop, so a reply with no window open is posted at once
// rather than waiting for a 30 s drain tick.

test("reply with no route window open → posted to the claim channel within 2 s", async (t) => {
  const s = setup(t, { claims: [["peerE", "C5"]] });
  const started = Date.now();
  s.broker.deliver("slack-bridge", { from_id: "peerE", text: "sent with no window open" });

  await waitFor(() => hasPost(s.web, "sent with no window open"), 2000);
  assert.ok(Date.now() - started < 2000, "delivered by the loop, not a 30 s drain tick");
  assert.ok(!hasUpdate(s.web, "sent with no window open"), "no window was open — it is a plain post, not a placeholder update");
});

test("reply with no route window open → converted to Slack mrkdwn", async (t) => {
  const s = setup(t, { claims: [["peerE", "C5"]] });
  s.broker.deliver("slack-bridge", { from_id: "peerE", text: "**TL;DR:** done" });
  await waitFor(() => hasPost(s.web, "done"), 2000);
  assert.ok(hasPost(s.web, "*TL;DR:* done"), "**bold** must become *bold*");
});

test("reply from a peer with no claim → dropped and logged, the loop keeps running", async (t) => {
  const s = setup(t, { claims: [["peerA", "C1"]] });
  s.broker.deliver("slack-bridge", { from_id: "ghost-peer", text: "orphan reply" });
  await delay(150);

  assert.ok(!hasPost(s.web, "orphan reply"), "a reply with no claim has nowhere to go — it must not be posted");
  assert.ok(
    s.log.entries.some((e) => e[0] === "warn" && String(e[1]).includes("no claim")),
    "the drop must be logged",
  );

  s.broker.deliver("slack-bridge", { from_id: "peerA", text: "a real reply" });
  await waitFor(() => hasPost(s.web, "a real reply"), 2000);
});

test("two routed messages, no reply to the first → the second reaches the broker immediately", async (t) => {
  const s = setup(t, { claims: [["peerN", "C-N"]], replyTimeoutMs: 60_000 });
  await slack(s, makePayload({ channel: "C-N", text: "first", client_msg_id: "m-hold-1" }));
  await waitFor(() => s.broker.sendCalls.length === 1);

  // The first message's window is still open and unanswered. It must not hold the
  // channel queue: a second Slack message is its own turn for the live session.
  await slack(s, makePayload({ channel: "C-N", text: "second", client_msg_id: "m-hold-2" }));
  await waitFor(() => s.broker.sendCalls.length === 2, 1500);

  assert.deepEqual(s.broker.sendCalls.map((c) => c.text), ["first", "second"]);
});

const placeholderTss = (web) =>
  web.calls.filter(([ty, p]) => ty === "post" && p.attachments?.[0]?.color === "#808080").map(([, p]) => p._ts);

// One session turn answers everything queued, so its reply belongs at the bottom
// of the channel — under the newest message — not in a placeholder scrolled away.
test("a reply resolves the NEWEST window; older unanswered placeholders are abandoned", async (t) => {
  const s = setup(t, { claims: [["peerF", "C-F"]], replyTimeoutMs: 60_000 });
  await slack(s, makePayload({ channel: "C-F", text: "first", client_msg_id: "m-new-1" }));
  await waitFor(() => s.broker.sendCalls.length === 1);
  await slack(s, makePayload({ channel: "C-F", text: "second", client_msg_id: "m-new-2" }));
  await waitFor(() => s.broker.sendCalls.length === 2);
  const [firstTs, secondTs] = placeholderTss(s.web);
  assert.notEqual(firstTs, secondTs, "each routed message gets its own placeholder");

  s.broker.deliver("slack-bridge", { from_id: "peerF", text: "answer to both" });
  await waitFor(() => hasUpdate(s.web, "answer to both"), 4000);
  const reply = s.web.calls.find(([ty, p]) => ty === "update" && p.text?.includes("answer to both"))[1];
  assert.equal(reply.ts, secondTs, "the reply lands in the newest placeholder");
  assert.ok(s.web.calls.some(([ty, p]) => ty === "delete" && p.ts === firstTs), "the older placeholder is deleted");
  assert.equal(s.hb.instances[0].stopped, true, "the abandoned window's heartbeat is stopped");
});

test("a window already collecting a reply keeps its chunks when a newer message arrives", async (t) => {
  const s = setup(t, { claims: [["peerF", "C-F"]], replyTimeoutMs: 60_000 });
  await slack(s, makePayload({ channel: "C-F", text: "first", client_msg_id: "m-col-1" }));
  await waitFor(() => s.broker.sendCalls.length === 1);
  s.broker.deliver("slack-bridge", { from_id: "peerF", text: "chunk one" });
  await delay(100);
  await slack(s, makePayload({ channel: "C-F", text: "second", client_msg_id: "m-col-2" }));
  await waitFor(() => s.broker.sendCalls.length === 2);
  s.broker.deliver("slack-bridge", { from_id: "peerF", text: "chunk two" });

  const [firstTs, secondTs] = placeholderTss(s.web);
  await waitFor(() => hasPost(s.web, "chunk two"), 4000);
  const first = s.web.calls.find(([ty, p]) => ty === "update" && p.text === "chunk one")[1];
  assert.equal(first.ts, firstTs, "the collecting window keeps the reply it started");
  assert.ok(!s.web.calls.some(([ty, p]) => ty === "delete" && p.ts === secondTs), "the newer window stays open");
  assert.equal(s.hb.instances[1].stopped, false);
});

test("status while a window is open → shown above the placeholder's attachment, no separate line", async (t) => {
  const s = setup(t, { claims: [["peerH", "C-H"]], replyTimeoutMs: 60_000 });
  await slack(s, makePayload({ channel: "C-H", text: "go", client_msg_id: "m-st-1" }));
  await waitFor(() => s.broker.sendCalls.length === 1);
  s.broker.deliver("slack-bridge", { from_id: "peerH", kind: "status", text: "Bash: node --test" });
  await waitFor(() => s.hb.instances[0].statuses.length === 1, 2000);
  assert.deepEqual(s.hb.instances[0].statuses, ["Bash: node --test"]);
  assert.ok(!hasPost(s.web, "Bash:"), "no separate status message below the placeholder");
});

// Item 13: a session sitting on an AskUserQuestion dialog cannot reply, so a
// message sent meanwhile must wait for it rather than time out.
test("question → resolves the open window; messages sent while it is pending don't time out until the session moves", async (t) => {
  const s = setup(t, { claims: [["peerQ", "C-Q"]], replyTimeoutMs: 200 });
  await slack(s, makePayload({ channel: "C-Q", text: "fix it", client_msg_id: "m-q-1" }));
  await waitFor(() => s.broker.sendCalls.length === 1);
  s.broker.deliver("slack-bridge", { from_id: "peerQ", kind: "question", text: "Which branch should the fix land on?" });
  await waitFor(() => hasUpdate(s.web, "Which branch"), 2000);

  await slack(s, makePayload({ channel: "C-Q", text: "followups", client_msg_id: "m-q-2" }));
  await waitFor(() => s.broker.sendCalls.length === 2);
  await delay(600);
  assert.equal(s.hb.instances[1].statuses.length, 0, "a held window gets no soft notice while the dialog is pending");

  s.broker.deliver("slack-bridge", { from_id: "peerQ", kind: "status", text: "Bash: git switch" });
  await waitFor(() => s.hb.instances[1].statuses.length === 1, 3000);
});

test("question pending and the session never moves → the held window goes straight to the ceiling, no soft notice", async (t) => {
  const s = setup(t, { claims: [["peerD", "C-D"]], replyTimeoutMs: 80 });
  await slack(s, makePayload({ channel: "C-D", text: "fix it", client_msg_id: "m-d-1" }));
  await waitFor(() => s.broker.sendCalls.length === 1);
  s.broker.deliver("slack-bridge", { from_id: "peerD", kind: "question", text: "Which branch?" });
  await waitFor(() => hasUpdate(s.web, "Which branch"), 2000);

  await slack(s, makePayload({ channel: "C-D", text: "followups", client_msg_id: "m-d-2" }));
  await waitFor(() => s.broker.sendCalls.length === 2);
  await delay(300);
  assert.equal(s.hb.instances[1].statuses.length, 0, "a held window skips the soft notice and arms the ceiling directly");
  await waitFor(() => s.web.calls.some(([ty, p]) => ty === "update" && NO_REPLY_RE.test(String(p.text ?? ""))), 4000);
  assert.equal(s.hb.instances[1].stopped, true, "the held window's heartbeat stops at the ceiling");
});

test("broker ECONNRESET mid-loop → the loop retries and delivers the next reply", async (t) => {
  _resetRouteState();
  const claims = createClaimsStore({ path: tmpClaims() });
  await claims.claim("peerG", "C-G");
  const broker = makeFakeBroker({ failWaits: 2 });
  const web = makeWeb();
  const log = makeLog();
  const loop = startReplyLoop({ broker, claims, web, log, _sleep: async () => {} });
  t.after(() => loop.stop());

  broker.deliver("slack-bridge", { from_id: "peerG", text: "survived the reset" });
  await waitFor(() => hasPost(web, "survived the reset"), 3000);
  assert.ok(broker.waitCalls >= 3, "two failed windows were retried, not fatal");
});

// ── Terminal turns: the same _Working…_ block as a Slack turn ────────────────

test("a status with no open window opens the _Working…_ block and starts a heartbeat", async (t) => {
  const s = setup(t, { claims: [["peerH", "C-H"]], replyTimeoutMs: 60_000 });
  s.broker.deliver("slack-bridge", { from_id: "peerH", kind: "status", text: "Bash: node --test" });

  await waitFor(() => s.hb.instances.length === 1 && s.hb.instances[0].statuses.length === 1, 3000);

  const [ts] = placeholderTss(s.web);
  assert.ok(ts, "a status with no window posts the heartbeat's _Working…_ placeholder");
  const block = s.web.calls.find(([ty, p]) => ty === "post" && p._ts === ts)[1];
  assert.equal(block.attachments[0].text, "_Working…_");
  assert.equal(s.hb.instances[0].ts, ts, "the heartbeat drives that placeholder");
  assert.deepEqual(s.hb.instances[0].statuses, ["Bash: node --test"]);
});

test("two statuses dispatched together post one placeholder", async (t) => {
  const s = setup(t, { claims: [["peerH2", "C-H2"]], replyTimeoutMs: 60_000 });
  s.broker.deliverAll("slack-bridge", [
    { from_id: "peerH2", kind: "status", text: "Bash: node --test" },
    { from_id: "peerH2", kind: "status", text: "Read: handler.mjs" },
  ]);

  await waitFor(() => s.hb.instances.length === 1 && s.hb.instances[0].statuses.length === 2, 3000);
  assert.equal(placeholderTss(s.web).length, 1, "opening is single-flight per peer");
  assert.deepEqual(s.hb.instances[0].statuses, ["Bash: node --test", "Read: handler.mjs"]);
});

test("a reply to a terminal window lands in its placeholder", async (t) => {
  const s = setup(t, { claims: [["peerH3", "C-H3"]], replyTimeoutMs: 60_000 });
  s.broker.deliver("slack-bridge", { from_id: "peerH3", kind: "status", text: "Bash: npm test" });
  await waitFor(() => s.hb.instances.length === 1, 3000);
  const [ts] = placeholderTss(s.web);

  s.broker.deliver("slack-bridge", { from_id: "peerH3", text: "all green" });
  await waitFor(() => hasUpdate(s.web, "all green"), 4000);
  const reply = s.web.calls.find(([ty, p]) => ty === "update" && p.text === "all green")[1];
  assert.equal(reply.ts, ts, "the turn's reply replaces the block the tool opened");
});

test("kind:turn-end deletes a terminal window's placeholder and posts nothing", async (t) => {
  const s = setup(t, { claims: [["peerH4", "C-H4"]], replyTimeoutMs: 60_000 });
  s.broker.deliver("slack-bridge", { from_id: "peerH4", kind: "status", text: "Bash: ls" });
  await waitFor(() => s.hb.instances.length === 1, 3000);
  const [ts] = placeholderTss(s.web);
  const postsBefore = s.web.calls.filter(([ty]) => ty === "post").length;

  s.broker.deliver("slack-bridge", { from_id: "peerH4", kind: "turn-end" });
  await waitFor(() => s.web.calls.some(([ty, p]) => ty === "delete" && p.ts === ts), 3000);

  assert.equal(s.hb.instances[0].stopped, true, "the ceiling/heartbeat is stopped");
  assert.equal(
    s.web.calls.filter(([ty]) => ty === "post").length,
    postsBefore,
    "turn-end posts nothing — the block just goes",
  );
  assert.ok(!s.web.calls.some(([ty, p]) => ty === "update" && p.ts === ts && /No reply|_Error:/.test(String(p.text ?? ""))),
    "nothing replaced the placeholder with text");
});

// The Stop hook sends the mirrored text and then turn-end, and the daemon takes
// them in one /wait batch. A turn-end that deletes the block the answer is
// landing in loses the answer and never acks it.
test("text then turn-end in one batch: the answer lands in the block, is not deleted, and both ack", async (t) => {
  const s = setup(t, { claims: [["peerH4b", "C-H4b"]], replyTimeoutMs: 60_000 });
  s.broker.deliver("slack-bridge", { from_id: "peerH4b", kind: "status", text: "Bash: ls" });
  await waitFor(() => s.hb.instances.length === 1, 3000);
  const [ts] = placeholderTss(s.web);

  s.broker.deliverAll("slack-bridge", [
    { id: 41, from_id: "peerH4b", text: "the answer" },
    { id: 42, from_id: "peerH4b", kind: "turn-end" },
  ]);

  await waitFor(() => hasUpdate(s.web, "the answer"), 4000);
  const reply = s.web.calls.find(([ty, p]) => ty === "update" && p.text === "the answer")[1];
  assert.equal(reply.ts, ts, "the answer replaces the block the turn opened");
  assert.ok(!s.web.calls.some(([ty, p]) => ty === "delete" && p.ts === ts), "the block is not deleted out from under the answer");
  await waitFor(() => s.broker.acked.includes(41) && s.broker.acked.includes(42), 3000);
});

test("a terminal window outlives replyTimeoutMs while a tool runs", async (t) => {
  const s = setup(t, { claims: [["peerH5", "C-H5"]], replyTimeoutMs: 80 });
  s.broker.deliver("slack-bridge", { from_id: "peerH5", kind: "status", text: "Bash: long build" });
  await waitFor(() => s.hb.instances.length === 1, 3000);
  const [ts] = placeholderTss(s.web);

  await delay(400); // five soft windows' worth: replyTimeoutMs does not apply

  assert.equal(s.hb.instances[0].stopped, false, "the block is still live");
  assert.deepEqual(s.hb.instances[0].statuses, ["Bash: long build"], "the tool status and no soft notice");
  assert.ok(!s.web.calls.some(([ty, p]) => ty === "delete" && p.ts === ts), "the placeholder was not torn down");
});

test("a status within 5s of a window closing opens nothing", async (t) => {
  const s = setup(t, { claims: [["peerH6", "C-H6"]], replyTimeoutMs: 60_000 });
  await slack(s, makePayload({ channel: "C-H6", text: "go", client_msg_id: "m-late-1" }));
  await waitFor(() => s.broker.sendCalls.length === 1);
  s.broker.deliver("slack-bridge", { from_id: "peerH6", text: "answered" });
  await waitFor(() => hasUpdate(s.web, "answered"), 4000);

  // PostToolUse is async: this status can land after the reply already closed the window.
  s.broker.deliver("slack-bridge", { from_id: "peerH6", kind: "status", text: "Edit: handler.mjs" });
  await delay(200);

  assert.equal(placeholderTss(s.web).length, 1, "the late status opens no second block");
  assert.equal(s.hb.instances.length, 1, "and starts no heartbeat");
});

test("a close mark older than the late-status window is pruned on the next close", async (t) => {
  const s = setup(t, { claims: [["peerL1", "C-L1"], ["peerL2", "C-L2"]], replyTimeoutMs: 60_000 });
  // Age a peer's mark as a long-running daemon would: one entry per peer id,
  // written on every close and otherwise never evicted. 5 s is the late-status
  // window, spelled out so the pin does not move with the constant.
  const staleAt = Date.now() - 5001;
  _closedMarks().set("peer-ancient", staleAt);

  s.broker.deliver("slack-bridge", { from_id: "peerL2", kind: "status", text: "Bash: ls" });
  await waitFor(() => s.hb.instances.length === 1, 3000);
  s.broker.deliver("slack-bridge", { from_id: "peerL2", kind: "turn-end" });
  await waitFor(() => _closedMarks().has("peerL2"), 3000);

  assert.equal(_closedMarks().has("peer-ancient"), false, "the stale entry is evicted, not carried for the life of the daemon");
});

test("a status within 5s of a window closing opens nothing — the fresh mark survives a prune", async (t) => {
  const s = setup(t, { claims: [["peerL3", "C-L3"]], replyTimeoutMs: 60_000 });
  const freshAt = Date.now() - 100;
  _closedMarks().set("peer-fresh", freshAt);

  s.broker.deliver("slack-bridge", { from_id: "peerL3", kind: "status", text: "Bash: ls" });
  await waitFor(() => s.hb.instances.length === 1, 3000);

  assert.equal(_closedMarks().get("peer-fresh"), freshAt, "a mark inside the window is kept — that is the guard");
});

// ── A prompt typed at the terminal is mirrored to Slack ─────────────────────

test("kind:prompt posts under the operator's name and icon, and opens one terminal window", async (t) => {
  const s = setup(t, { claims: [["peerP", "C-P"]], replyTimeoutMs: 60_000 });
  s.config.remote.operatorName = "Andrew";
  s.config.remote.operatorIconUrl = "https://example.test/avatar.png";
  s.broker.deliver("slack-bridge", { from_id: "peerP", kind: "prompt", text: "typed at the terminal" });

  await waitFor(() => hasPost(s.web, "typed at the terminal"), 3000);
  const post = s.web.calls.find(([ty, p]) => ty === "post" && p.text === "typed at the terminal")[1];
  assert.equal(post.username, "Andrew");
  assert.equal(post.icon_url, "https://example.test/avatar.png");
  await waitFor(() => s.hb.instances.length === 1, 3000);
  assert.equal(placeholderTss(s.web).length, 1, "the typed prompt opens exactly one working block");
});

test("kind:prompt with no operator name posts a keyboard-marked message under the bot's name", async (t) => {
  const s = setup(t, { claims: [["peerP2", "C-P2"]], replyTimeoutMs: 60_000 });
  s.broker.deliver("slack-bridge", { from_id: "peerP2", kind: "prompt", text: "**hello** from the terminal" });

  await waitFor(() => hasPost(s.web, "hello"), 3000);
  const post = s.web.calls.find(([ty, p]) => ty === "post" && p.text?.includes("hello"))[1];
  assert.equal(post.text, "⌨️ *hello* from the terminal", "the keyboard branch converts markdown like every other post");
  assert.equal("username" in post, false, "no custom username without remote.operatorName");
});

// The icon is independent of the name, so an icon-only config still has no name
// to sign with: the ⌨️ marker is what says "typed elsewhere".
test("kind:prompt with an icon but no operator name still carries the ⌨️ marker", async (t) => {
  const s = setup(t, { claims: [["peerP5", "C-P5"]], replyTimeoutMs: 60_000 });
  s.config.remote.operatorIconUrl = "https://example.test/avatar.png";
  s.broker.deliver("slack-bridge", { from_id: "peerP5", kind: "prompt", text: "**hi**" });

  await waitFor(() => hasPost(s.web, "hi"), 3000);
  const post = s.web.calls.find(([ty, p]) => ty === "post" && p.text?.includes("hi"))[1];
  assert.equal(post.text, "⌨️ *hi*");
  assert.equal(post.icon_url, "https://example.test/avatar.png", "the icon is still sent; only the marker is keyed on the name");
  assert.equal("username" in post, false);
});

// Slack rejects username/icon_url without chat:write.customize. A prompt stuck
// failing there is never acked, so the broker redelivers it on every lease expiry.
test("kind:prompt retries once as the plain ⌨️ post when the custom identity is rejected", async (t) => {
  const s = setup(t, { claims: [["peerP6", "C-P6"]], replyTimeoutMs: 60_000 });
  s.config.remote.operatorName = "Andrew";
  s.config.remote.operatorIconUrl = "https://example.test/avatar.png";
  const post = s.web.chatPostMessage;
  let rejected = 0;
  s.web.chatPostMessage = async (p) => {
    if (p.username) { rejected++; throw new Error("invalid_arguments"); }
    return post(p);
  };

  s.broker.deliver("slack-bridge", { id: 61, from_id: "peerP6", kind: "prompt", text: "**typed**" });
  await waitFor(() => hasPost(s.web, "typed"), 3000);

  assert.equal(rejected, 1, "the custom-identity post is attempted once, not retried");
  const plain = s.web.calls.find(([ty, p]) => ty === "post" && p.text?.includes("typed"))[1];
  assert.equal(plain.text, "⌨️ *typed*");
  assert.equal("username" in plain, false, "the retry drops the identity Slack rejected");
  await waitFor(() => s.broker.acked.includes(61), 3000);
});

test("a mirrored terminal prompt coming back as a Slack event is ignored as a bot message", async (t) => {
  const s = setup(t, { claims: [["peerP3", "C-P3"]], replyTimeoutMs: 60_000 });
  const rc = makeRunClaude();

  // The loop's second half: our own custom-username post is delivered back as an
  // event. Slack marks bot posts with bot_id, and the handler drops them there.
  await slack(s, { ...makePayload({ channel: "C-P3", text: "typed at the terminal", client_msg_id: "m-echo" }), bot_id: "B0BRIDGE" }, { runClaude: rc });
  await delay(100);

  assert.equal(s.broker.sendCalls.length, 0, "the mirrored prompt must not be routed back into the session");
  assert.equal(rc.calls.length, 0, "and must not spawn");
  assert.ok(
    s.log.entries.some((e) => e[0] === "info" && e[1] === "message skipped" && e[2]?.reason === "bot_message"),
    "the skip is the bot filter, not an empty-text accident",
  );
});

// ── Fallback paths ──────────────────────────────────────────────────────────

test("unclaimed channel → runClaude spawn path taken, no broker send", async (t) => {
  const s = setup(t, { claims: [] });
  const rc = makeRunClaude();
  await slack(s, makePayload({ channel: "C-unclaimed", text: "hi", client_msg_id: "m-route-2" }), { runClaude: rc });
  await waitFor(() => rc.calls.length === 1, 3000);
  assert.equal(s.broker.sendCalls.length, 0, "no broker send for an unclaimed channel");
});

test("claimed channel + dead peer → red block, fallback spawn, claim reaped, no broker send", async (t) => {
  const s = setup(t, { alive: [], claims: [["peerB", "C2"]] });
  const rc = makeRunClaude();
  await slack(s, makePayload({ channel: "C2", text: "hello", client_msg_id: "m-route-3" }), { runClaude: rc });
  await waitFor(() => rc.calls.length === 1, 3000);
  assert.equal(s.broker.sendCalls.length, 0, "must not send to a dead peer");
  assert.equal(s.claims.get("C2"), null, "the dead peer's claim must be reaped");
  assert.ok(posted(s.web, "is disconnected"), "the operator is told the session is gone, not just that it was slow");
});

// ── The #rc-* guard ─────────────────────────────────────────────────────────
// A channel that was once seized never spawns a claude -p session: the two
// transcripts in one channel are confusing to read back. The record outlives the
// claim, so this holds after release; a channel with no record is untouched.

test("a message in an unclaimed once-seized #rc-* channel posts the red block and never spawns", async (t) => {
  const s = setup(t, { claims: [] });
  s.claims.recordHistory("C-rc", { session_id: "sess-gone", channel_name: "rc-demo" });
  const rc = makeRunClaude();
  await slack(s, makePayload({ channel: "C-rc", text: "still there?", client_msg_id: "m-rc-1" }), { runClaude: rc });
  await delay(150);

  assert.equal(rc.calls.length, 0, "an rc channel must never spawn");
  assert.equal(s.broker.sendCalls.length, 0);
  assert.ok(posted(s.web, "is disconnected"), JSON.stringify(s.web.calls));
  assert.ok(posted(s.web, "sess-gone"), "the block names the session that went");
});

test("a released non-rc channel still reaches the spawn path and shows no block", async (t) => {
  const s = setup(t, { claims: [] });
  s.claims.recordHistory("C-ops", { session_id: "sess-ops", channel_name: "ops" });
  const rc = makeRunClaude();
  await slack(s, makePayload({ channel: "C-ops", text: "hi", client_msg_id: "m-rc-2" }), { runClaude: rc });
  await waitFor(() => rc.calls.length === 1, 3000);

  assert.ok(!posted(s.web, "is disconnected"), "a hand-made channel keeps the ordinary behaviour");
});

test("a dead peer's #rc-* channel gets one red block and never spawns", async (t) => {
  const s = setup(t, { alive: [], claims: [["peerD", "C-rc3"]] });
  s.claims.recordHistory("C-rc3", { session_id: "sess-dead", channel_name: "rc-dead" });
  const rc = makeRunClaude();
  await slack(s, makePayload({ channel: "C-rc3", text: "hello", client_msg_id: "m-rc-4" }), { runClaude: rc });
  await delay(150);

  assert.equal(rc.calls.length, 0, "no spawn in an rc channel, dead peer or not");
  assert.equal(s.broker.sendCalls.length, 0);
  const blocks = s.web.calls.filter(([t, p]) => t === "post"
    && (p.attachments ?? []).some((a) => String(a.text ?? "").includes("is disconnected")));
  assert.equal(blocks.length, 1, "one block, not two");
  assert.equal(s.claims.get("C-rc3"), null, "the claim is released");
});

test("a broker outage in an #rc-* channel posts the broker message and never spawns", async (t) => {
  const s = setup(t, { claims: [["peerC", "C-rc2"]], down: true });
  s.claims.recordHistory("C-rc2", { session_id: "sess-live", channel_name: "rc-live" });
  const rc = makeRunClaude();
  await slack(s, makePayload({ channel: "C-rc2", text: "hi", client_msg_id: "m-rc-3" }), { runClaude: rc });
  await delay(150);

  assert.equal(rc.calls.length, 0, "the broker-down exception does not reach an rc channel");
  assert.ok(posted(s.web, "Bridge can't reach the broker. Your message was not delivered."), JSON.stringify(s.web.calls));
  assert.ok(s.claims.get("C-rc2"), "a broker outage keeps the claim — slow is not dead");
});


test("channel_join / channel_topic in a claimed channel → skipped: no broker send, no spawn", async (t) => {
  const s = setup(t, { claims: [["peerJ", "C-J"]] });
  const rc = makeRunClaude();

  for (const subtype of ["channel_join", "channel_topic"]) {
    // Real join/topic payloads carry text, and it survives the bot-mention strip —
    // the skip has to come from the subtype, not from "empty_after_strip".
    await slack(s, makePayload({
      channel: "C-J", subtype,
      text: `<@U999> has ${subtype === "channel_join" ? "joined" : "set the topic of"} the channel`,
      client_msg_id: `m-${subtype}`,
    }), { runClaude: rc });
  }
  await delay(100);

  assert.equal(s.broker.sendCalls.length, 0, "no route to the live session for join/topic noise");
  assert.equal(rc.calls.length, 0, "no spawn either");
  for (const subtype of ["channel_join", "channel_topic"]) {
    assert.ok(
      s.log.entries.some((e) => e[0] === "info" && e[1] === "message skipped" && e[2]?.reason === subtype),
      `the skip must be logged with reason ${subtype}`,
    );
  }

  // The channel is still live: a real message routes as before.
  await slack(s, makePayload({ channel: "C-J", text: "an actual question", client_msg_id: "m-j-real" }), { runClaude: rc });
  await waitFor(() => s.broker.sendCalls.length === 1, 3000);
  assert.equal(s.broker.sendCalls[0].text, "an actual question");
});
