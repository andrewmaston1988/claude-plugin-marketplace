// Integration: the routing branch in handleMessage and the daemon reply loop,
// against a fake broker, fake web and injected runClaude/heartbeat.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleMessage, startReplyLoop, _resetRouteState } from "../../src/core/handler.mjs";
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
    const rec = { channel, ts, cmdEcho, extensions, tools: [], stopped: false, stopCalls: 0 };
    instances.push(rec);
    calls.push(["hb-start", rec]);
    return {
      setTool(tool, input) { rec.tools.push([tool, input]); },
      stop() { rec.stopped = true; rec.stopCalls++; calls.push(["hb-stop", rec]); return Promise.resolve(); },
    };
  }
  return { start, instances };
}

// Fake broker client: in-memory, no HTTP. `deliver` pushes a message addressed to
// the daemon peer; the loop's open `wait` takes it (or it queues until one opens).
function makeFakeBroker({ alive = new Set(), failWaits = 0 } = {}) {
  const sendCalls = [];
  const inbox = new Map();     // peerId → queued messages
  const waiters = new Map();   // peerId → resolve fn
  let failures = failWaits;
  const broker = {
    sendCalls,
    waitCalls: 0,
    async isAlive(peerId) { return alive.has(peerId); },
    async sendMessage(fromId, toId, text) { sendCalls.push({ from_id: fromId, to_id: toId, text }); return { ok: true }; },
    deliver(peerId, message) {
      const wake = waiters.get(peerId);
      if (wake) { waiters.delete(peerId); wake([message]); return; }
      if (!inbox.has(peerId)) inbox.set(peerId, []);
      inbox.get(peerId).push(message);
    },
    wait(id, timeoutMs, { signal } = {}) {
      broker.waitCalls++;
      if (failures > 0) { failures--; return Promise.reject(new TypeError("fetch failed")); }
      const queued = inbox.get(id);
      if (queued?.length) return Promise.resolve({ messages: [queued.shift()] });
      return new Promise((resolve) => {
        // Real windows are 55 s; a test window is only long enough to interleave.
        const timer = setTimeout(() => { waiters.delete(id); resolve({ messages: [] }); }, Math.min(timeoutMs, 40));
        const wake = (messages) => { clearTimeout(timer); resolve({ messages }); };
        waiters.set(id, wake);
        signal?.addEventListener?.("abort", () => { waiters.delete(id); clearTimeout(timer); resolve({ messages: [] }); });
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
function setup(t, { replyTimeoutMs = 3000, claims: preClaims = [], alive: aliveOverride } = {}) {
  _resetRouteState();
  const claims = createClaimsStore({ path: tmpClaims() });
  for (const [peer, channel] of preClaims) claims.claim(peer, channel);
  // By default every claimed peer is live; a test passes `alive: []` to kill them.
  const alive = aliveOverride ?? preClaims.map(([peer]) => peer);
  const broker = makeFakeBroker({ alive: new Set(alive) });
  const web = makeWeb();
  const hb = makeHeartbeat(web.calls);
  const log = makeLog();
  const config = { slack: {}, claude: { cwd: "/tmp", timeout: 1000 }, remote: { replyTimeoutMs } };
  const loop = startReplyLoop({ broker, claims, web, log, _sleep: async () => {} });
  t.after(() => loop.stop());
  // ONE queue for the whole test, as the bridge has: it is the serialisation the
  // "a routed message must not hold the channel queue" case depends on.
  const queue = createQueue({ log: makeLog() });
  return { claims, broker, web, hb, log, config, loop, queue };
}

// Drive one Slack message through handleMessage with the harness wired in.
async function slack(s, payload, { runClaude, extensions = null } = {}) {
  return handleMessage({
    web: s.web, store: makeStore(), queue: s.queue, config: s.config, log: s.log,
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

test("reply timeout → 'didn't reply in time' posted, heartbeat stopped, claim retained", async (t) => {
  const s = setup(t, { claims: [["peerC", "C3"]], replyTimeoutMs: 200 });
  const rc = makeRunClaude();
  await slack(s, makePayload({ channel: "C3", text: "hello", client_msg_id: "m-route-4" }), { runClaude: rc });

  await waitFor(() => hasUpdate(s.web, "didn't reply"), 3000);

  assert.equal(rc.calls.length, 0, "must not spawn on a claimed+live channel even on timeout");
  assert.ok(s.claims.get("C3"), "claim must be retained after a reply timeout (peer may be slow, not dead)");
  assert.equal(s.hb.instances[0].stopped, true, "the timeout branch stops the heartbeat");
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

test("replies resolve windows oldest-first (FIFO)", async (t) => {
  const s = setup(t, { claims: [["peerF", "C-F"]], replyTimeoutMs: 60_000 });
  await slack(s, makePayload({ channel: "C-F", text: "first", client_msg_id: "m-fifo-1" }));
  await waitFor(() => s.broker.sendCalls.length === 1);
  const firstTs = s.web.calls.filter(([ty, p]) => ty === "post" && p.attachments?.[0]?.color === "#808080")[0][1]._ts;

  await slack(s, makePayload({ channel: "C-F", text: "second", client_msg_id: "m-fifo-2" }));
  await waitFor(() => s.broker.sendCalls.length === 2);
  const secondTs = s.web.calls.filter(([ty, p]) => ty === "post" && p.attachments?.[0]?.color === "#808080")[1][1]._ts;
  assert.notEqual(firstTs, secondTs, "each routed message gets its own placeholder");

  s.broker.deliver("slack-bridge", { from_id: "peerF", text: "answer to first" });
  await waitFor(() => hasUpdate(s.web, "answer to first"), 4000);
  const firstReply = s.web.calls.find(([ty, p]) => ty === "update" && p.text?.includes("answer to first"))[1];
  assert.equal(firstReply.ts, firstTs, "the oldest window resolves first");

  // The first window has finalised (its quiet gap elapsed) — the next reply
  // belongs to the second message.
  s.broker.deliver("slack-bridge", { from_id: "peerF", text: "answer to second" });
  await waitFor(() => hasUpdate(s.web, "answer to second"), 4000);
  const secondReply = s.web.calls.find(([ty, p]) => ty === "update" && p.text?.includes("answer to second"))[1];
  assert.equal(secondReply.ts, secondTs, "the second window resolves second");
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

test("status messages → one Slack message edited in place, cleared when the reply finalises", async (t) => {
  const s = setup(t, { claims: [["peerH", "C-H"]] });
  s.broker.deliver("slack-bridge", { from_id: "peerH", kind: "status", text: "Bash: node --test" });
  await waitFor(() => hasPost(s.web, "Bash: node --test"), 2000);
  const statusTs = s.web.calls.find(([ty, p]) => ty === "post" && p.text?.includes("Bash:"))[1]._ts;

  s.broker.deliver("slack-bridge", { from_id: "peerH", kind: "status", text: "Read: handler.mjs" });
  s.broker.deliver("slack-bridge", { from_id: "peerH", kind: "status", text: "Edit: handler.mjs" });
  await waitFor(() => s.web.calls.filter(([ty, p]) => ty === "update" && p.ts === statusTs).length >= 2, 3000);

  assert.equal(
    s.web.calls.filter(([ty, p]) => ty === "post" && [(p.text ?? "")].some((x) => x.includes("Read:") || x.includes("Edit:"))).length,
    0,
    "later status messages edit the one line, they do not post again",
  );
  const last = s.web.calls.filter(([ty, p]) => ty === "update" && p.ts === statusTs).pop()[1];
  assert.equal(last.text, "Edit: handler.mjs", "the line shows the newest tool");

  s.broker.deliver("slack-bridge", { from_id: "peerH", text: "done with the tools" });
  await waitFor(() => hasPost(s.web, "done with the tools"), 2000);
  assert.ok(
    s.web.calls.some(([ty, p]) => ty === "delete" && p.ts === statusTs),
    "the text reply finalises/clears the status line",
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

test("claimed channel + dead peer → fallback spawn, claim reaped, no broker send", async (t) => {
  const s = setup(t, { alive: [], claims: [["peerB", "C2"]] });
  const rc = makeRunClaude();
  await slack(s, makePayload({ channel: "C2", text: "hello", client_msg_id: "m-route-3" }), { runClaude: rc });
  await waitFor(() => rc.calls.length === 1, 3000);
  assert.equal(s.broker.sendCalls.length, 0, "must not send to a dead peer");
  assert.equal(s.claims.get("C2"), null, "the dead peer's claim must be reaped");
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
