// Integration: the load-bearing routing branch in handleMessage. A Slack message
// on a claimed channel with a live claiming peer is routed to the internal broker
// (no claude -p spawn); the polled reply is posted back. Unclaimed or dead-peer
// channels fall back to the spawn path. Fake broker + fake web + injected runClaude
// — no real Slack, no real subprocess.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleMessage, drainIdleLeftovers } from "../../src/core/handler.mjs";
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
function makeWeb() {
  const calls = [];
  return {
    calls,
    chatPostMessage: async (p) => { calls.push(["post", p]); return { ts: "ph-ts", ok: true }; },
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
// Fake broker client: in-memory, no HTTP. `messages` is the drain pool the test
// injects replies into; pollMessages slices it (marks delivered, like the real one).
function makeFakeBroker({ alive = new Set(), messages = [] } = {}) {
  const sendCalls = [];
  return {
    sendCalls,
    async isAlive(peerId) { return alive.has(peerId); },
    async sendMessage(fromId, toId, text) { sendCalls.push({ from_id: fromId, to_id: toId, text }); return { ok: true }; },
    async pollMessages() { return messages.splice(0); },
  };
}
async function waitFor(pred, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await delay(20);
  }
  throw new Error("waitFor timed out");
}

test("claimed channel + live peer → routed to broker, runClaude NOT called, reply posted back", async () => {
  const claims = createClaimsStore({ path: tmpClaims() });
  await claims.claim("peerA", "C1");
  const messages = [];
  const broker = makeFakeBroker({ alive: new Set(["peerA"]), messages });
  const web = makeWeb();
  const rc = makeRunClaude();
  const config = { slack: {}, claude: { cwd: "/tmp", timeout: 1000 }, remote: { replyTimeoutMs: 3000, replyPollIntervalMs: 20 } };

  // A stale reply to an earlier routed message, queued BEFORE this send: it must
  // never be served as this message's reply (the pre-send drain clears it), and
  // must never be destroyed either — it is posted to the channel as its own message.
  messages.push({ from_id: "peerA", text: "stale reply to an earlier message" });

  await handleMessage({
    web, store: makeStore(), queue: createQueue({ log: makeLog() }), config, log: makeLog(),
    payload: { type: "message", channel: "C1", text: "hello from slack", client_msg_id: "m-route-1" },
    botUserId: "U123", isFirstInSession: true, remote: { claims, broker }, _runClaude: rc.fn,
  });

  // The reply arrives causally — only after the routed send. The pre-send drain
  // clears anything queued before the send, so seeding earlier would be drained.
  await waitFor(() => broker.sendCalls.length === 1, 3000);
  messages.push({ from_id: "peerA", text: "live reply!" });
  await waitFor(() => web.calls.some(([t, p]) => t === "update" && typeof p.text === "string" && p.text.includes("live reply!")), 3000);

  assert.equal(rc.calls.length, 0, "runClaude must NOT be called for a claimed+live channel");
  assert.ok(
    broker.sendCalls.some((s) => s.from_id === "slack-bridge" && s.to_id === "peerA" && s.text === "hello from slack"),
    "must send the Slack message to the broker addressed to the claiming peer",
  );
  assert.ok(
    !web.calls.some(([t, p]) => t === "update" && typeof p.text === "string" && p.text.includes("stale")),
    "a stale pre-send reply must never be served as this message's reply",
  );
  assert.ok(
    web.calls.some(([t, p]) => t === "post" && typeof p.text === "string" && p.text.includes("stale")),
    "the stale reply must still reach the channel as its own message, not be destroyed by the drain",
  );
});

test("unclaimed channel → runClaude spawn path taken, no broker send", async () => {
  const claims = createClaimsStore({ path: tmpClaims() });
  const broker = makeFakeBroker({ alive: new Set(), messages: [] });
  const web = makeWeb();
  const rc = makeRunClaude();
  const config = { slack: {}, claude: { cwd: "/tmp", timeout: 1000 } };

  await handleMessage({
    web, store: makeStore(), queue: createQueue({ log: makeLog() }), config, log: makeLog(),
    payload: { type: "message", channel: "C-unclaimed", text: "hi", client_msg_id: "m-route-2" },
    botUserId: "U123", isFirstInSession: true, remote: { claims, broker }, _runClaude: rc.fn,
  });
  await waitFor(() => rc.calls.length === 1, 3000);
  assert.equal(broker.sendCalls.length, 0, "no broker send for an unclaimed channel");
});

test("claimed channel + dead peer → fallback spawn, claim reaped, no broker send", async () => {
  const claims = createClaimsStore({ path: tmpClaims() });
  await claims.claim("peerB", "C2");
  const broker = makeFakeBroker({ alive: new Set(), messages: [] }); // peerB not alive
  const web = makeWeb();
  const rc = makeRunClaude();
  const config = { slack: {}, claude: { cwd: "/tmp", timeout: 1000 } };

  await handleMessage({
    web, store: makeStore(), queue: createQueue({ log: makeLog() }), config, log: makeLog(),
    payload: { type: "message", channel: "C2", text: "hello", client_msg_id: "m-route-3" },
    botUserId: "U123", isFirstInSession: true, remote: { claims, broker }, _runClaude: rc.fn,
  });
  await waitFor(() => rc.calls.length === 1, 3000);
  assert.equal(broker.sendCalls.length, 0, "must not send to a dead peer");
  assert.equal(claims.get("C2"), null, "the dead peer's claim must be reaped");
});

test("reply timeout → 'live session didn't reply' posted; claim retained", async () => {
  const claims = createClaimsStore({ path: tmpClaims() });
  await claims.claim("peerC", "C3");
  const broker = makeFakeBroker({ alive: new Set(["peerC"]), messages: [] }); // never replies
  const web = makeWeb();
  const rc = makeRunClaude();
  const config = {
    slack: {}, claude: { cwd: "/tmp", timeout: 1000 },
    remote: { replyTimeoutMs: 200, replyPollIntervalMs: 20 },
  };

  await handleMessage({
    web, store: makeStore(), queue: createQueue({ log: makeLog() }), config, log: makeLog(),
    payload: { type: "message", channel: "C3", text: "hello", client_msg_id: "m-route-4" },
    botUserId: "U123", isFirstInSession: true, remote: { claims, broker }, _runClaude: rc.fn,
  });
  await waitFor(() => web.calls.some(([t, p]) => t === "update" && typeof p.text === "string" && p.text.includes("didn't reply")), 3000);

  assert.equal(rc.calls.length, 0, "must not spawn on a claimed+live channel even on timeout");
  assert.ok(claims.get("C3"), "claim must be retained after a reply timeout (peer may be slow, not dead)");
});

test("multi-chunk reply → every message posted, not just the first", async () => {
  const claims = createClaimsStore({ path: tmpClaims() });
  await claims.claim("peerD", "C4");
  const messages = [];
  const broker = makeFakeBroker({ alive: new Set(["peerD"]), messages });
  const web = makeWeb();
  const rc = makeRunClaude();
  const config = { slack: {}, claude: { cwd: "/tmp", timeout: 1000 }, remote: { replyTimeoutMs: 3000, replyPollIntervalMs: 20 } };

  await handleMessage({
    web, store: makeStore(), queue: createQueue({ log: makeLog() }), config, log: makeLog(),
    payload: { type: "message", channel: "C4", text: "hello", client_msg_id: "m-route-5" },
    botUserId: "U123", isFirstInSession: true, remote: { claims, broker }, _runClaude: rc.fn,
  });
  await waitFor(() => broker.sendCalls.length === 1, 3000);
  // A session replying in several slack_post chunks: all arrive inside the
  // reply window. Taking only the first would leave the rest marked-delivered
  // by the next routed message's pre-send drain — silently lost.
  messages.push({ from_id: "peerD", text: "chunk one" });
  messages.push({ from_id: "peerD", text: "chunk two" });

  await waitFor(() => web.calls.some(([t, p]) => t === "post" && typeof p.text === "string" && p.text.includes("chunk two")), 3000);
  assert.ok(
    web.calls.some(([t, p]) => t === "update" && typeof p.text === "string" && p.text.includes("chunk one")),
    "the first chunk must replace the routed placeholder",
  );
  assert.equal(rc.calls.length, 0, "runClaude must NOT be called for a claimed+live channel");
});

// --- idle drain ---
// slack_post cannot see whether a routing window is open. A reply landing after its
// window closed — or with none open — has no poller, so the daemon drains claimed
// peers on a tick and posts what it finds. Without this the message sits until the
// next route's pre-send drain marks it delivered, while the session was told it sent.

test("idle drain posts a leftover reply that no window consumed, once", async () => {
  const claims = createClaimsStore({ path: tmpClaims() });
  await claims.claim("peerE", "C5");
  const messages = [{ from_id: "peerE", text: "sent after the window closed" }];
  const broker = makeFakeBroker({ alive: new Set(["peerE"]), messages });
  const web = makeWeb();

  const posted = await drainIdleLeftovers({ broker, web, claims, log: makeLog() });
  assert.equal(posted, 1, "a leftover reply must be posted, never left to be destroyed");
  assert.ok(
    web.calls.some(([t, p]) => t === "post" && typeof p.text === "string" && p.text.includes("sent after the window closed")),
    "the leftover must reach the channel as its own message",
  );
  assert.equal(await drainIdleLeftovers({ broker, web, claims, log: makeLog() }), 0,
    "the second tick must find nothing — the reply was consumed by the first");
});

test("idle drain skips a peer whose route is polling, leaving the reply for that route", async () => {
  const claims = createClaimsStore({ path: tmpClaims() });
  await claims.claim("peerF", "C6");
  const messages = [];
  const broker = makeFakeBroker({ alive: new Set(["peerF"]), messages });
  const web = makeWeb();
  const rc = makeRunClaude();
  const config = { slack: {}, claude: { cwd: "/tmp", timeout: 1000 }, remote: { replyTimeoutMs: 3000, replyPollIntervalMs: 20 } };

  await handleMessage({
    web, store: makeStore(), queue: createQueue({ log: makeLog() }), config, log: makeLog(),
    payload: { type: "message", channel: "C6", text: "hello", client_msg_id: "m-route-6" },
    botUserId: "U123", isFirstInSession: true, remote: { claims, broker }, _runClaude: rc.fn,
  });
  await waitFor(() => broker.sendCalls.length === 1, 3000);

  // Pushed in the same macrotask as the drain call below, so the route's 20 ms poll
  // cannot have run yet: a drain ignoring the guard would see this and return 1.
  messages.push({ from_id: "peerF", text: "the reply the window is waiting for" });
  assert.equal(await drainIdleLeftovers({ broker, web, claims, log: makeLog() }), 0,
    "a drain under a live route would mark the in-flight reply delivered and destroy it");
  assert.ok(
    !web.calls.some(([t, p]) => t === "post" && typeof p.text === "string" && p.text.includes("the reply the window")),
    "the live route's reply must not be posted standalone",
  );
  await waitFor(() => web.calls.some(([t, p]) => t === "update" && typeof p.text === "string" && p.text.includes("the reply the window")), 3000);
});
