// A claim whose live session has gone: the daemon says so out loud instead of
// falling silent, and says it exactly once. Fake broker, fake web, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sweepClaims, markDisconnected, isRemoteChannel, disconnectText } from "../../src/core/disconnect.mjs";
import { routeToLiveSession, _resetRouteState } from "../../src/core/live-route.mjs";
import { createClaimsStore } from "../../src/remote/claims.mjs";

const RED = "#d00000";

function tmpClaims() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "disconnect-")), "claims.json");
}

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

function makeWeb() {
  const calls = [];
  let n = 0;
  return {
    calls,
    chatPostMessage: async (p) => { const ts = `ph-${++n}`; calls.push(["post", { ...p, _ts: ts }]); return { ts, ok: true }; },
    chatUpdate: async (p) => { calls.push(["update", p]); return {}; },
    chatDelete: async (p) => { calls.push(["delete", p]); return {}; },
  };
}

function makeHeartbeat(calls) {
  const instances = [];
  function start({ ts }) {
    const rec = { ts, statuses: [], stopped: false };
    instances.push(rec);
    calls.push(["hb-start", rec]);
    return {
      setTool() {},
      setStatus(text) { rec.statuses.push(text); },
      stop() { rec.stopped = true; calls.push(["hb-stop", rec]); return Promise.resolve(); },
    };
  }
  return { start, instances };
}

const redBlocks = (web) => web.calls.filter(([t, p]) =>
  t === "post" && (p.attachments ?? []).some((a) => a.color === RED && String(a.text).includes("is disconnected")));

// A claimed channel with a routed window open, ready to be swept.
async function claimedWithWindow({ channel = "C1", peer = "peerA", name = "rc-demo", sessionId = "sess-1" } = {}) {
  _resetRouteState();
  const claims = createClaimsStore({ path: tmpClaims() });
  claims.recordHistory(channel, { session_id: sessionId, channel_name: name });
  claims.claim(peer, channel, { channelName: name, sessionId });
  const web = makeWeb();
  const hb = makeHeartbeat(web.calls);
  const log = makeLog();
  const broker = { sendMessage: async () => ({ ok: true }) };
  await routeToLiveSession({
    web, channel, threadTs: null, text: "hello", claim: claims.get(channel), broker,
    config: { slack: {}, remote: { replyTimeoutMs: 60_000 } }, log, cmdEcho: "hello",
    _startHeartbeat: hb.start,
  });
  return { claims, web, hb, log, channel, peer };
}

test("a claim whose peer is absent gets one red block with the GUID, its windows closed with no error text, and is released", async () => {
  const { claims, web, hb, log, channel, peer } = await claimedWithWindow();

  const disconnected = await sweepClaims({ broker: { listPeers: async () => [] }, claims, web, log });

  assert.deepEqual(disconnected, [peer], "the sweep reports who it dropped");
  const blocks = redBlocks(web);
  assert.equal(blocks.length, 1, "one block, posted without the operator having to send anything");
  const text = blocks[0][1].attachments[0].text;
  assert.equal(text, "⚠️ Claude session `sess-1` is disconnected");
  assert.equal(claims.get(channel), null, "the claim is released");
  assert.equal(hb.instances[0].stopped, true, "the heartbeat is stopped");
  assert.ok(
    web.calls.some(([t, p]) => t === "delete" && p.ts === hb.instances[0].ts),
    "the placeholder is deleted",
  );
  assert.ok(
    !web.calls.some(([t, p]) => t === "update" && /stays queued|No reply after/.test(String(p.text ?? ""))),
    "nothing is written into the dead session's placeholder",
  );
});

test("the block names the session in backticks, as the seize and release lines do, and stays readable without one", () => {
  assert.equal(disconnectText("abc-123"), "⚠️ Claude session `abc-123` is disconnected");
  assert.equal(disconnectText(null), "⚠️ Claude session is disconnected");
});

test("a listPeers failure disconnects nothing — an unreachable broker is no reading", async () => {
  const { claims, web, log, channel } = await claimedWithWindow();

  const disconnected = await sweepClaims({
    broker: { listPeers: async () => { throw new TypeError("fetch failed"); } },
    claims, web, log,
  });

  assert.deepEqual(disconnected, []);
  assert.ok(claims.get(channel), "the claim survives a broker outage");
  assert.equal(redBlocks(web).length, 0, "no false red alarm");
});

test("a live peer is left alone", async () => {
  const { claims, web, log, channel, peer } = await claimedWithWindow();

  const disconnected = await sweepClaims({ broker: { listPeers: async () => [{ id: peer }] }, claims, web, log });

  assert.deepEqual(disconnected, []);
  assert.ok(claims.get(channel));
  assert.equal(redBlocks(web).length, 0);
});

test("a message racing the sweep gets one block, not two", async () => {
  const { claims, web, log, channel } = await claimedWithWindow();
  const claim = claims.get(channel);

  // The daemon's 30 s sweep and the handler's dead-peer branch both read the
  // same claim before either acts on it.
  const results = await Promise.all([
    markDisconnected({ claim, web, claims, log }),
    markDisconnected({ claim, web, claims, log }),
  ]);

  assert.deepEqual(results, [true, false], "the second caller finds no matching claim and does nothing");
  assert.equal(redBlocks(web).length, 1);
});

test("a channel re-seized by another peer gets no block", async () => {
  const { claims, web, log, channel } = await claimedWithWindow();
  const stale = claims.get(channel);
  claims.release("peerA");
  claims.claim("peerB", channel, { channelName: "rc-demo", sessionId: "sess-2" });

  const out = await markDisconnected({ claim: stale, web, claims, log });

  assert.equal(out, false, "the block never lands on a channel a live session now holds");
  assert.equal(redBlocks(web).length, 0);
  assert.equal(claims.get(channel).peer_id, "peerB");
});

test("the history record outlives release and supplies the GUID", async () => {
  const claims = createClaimsStore({ path: tmpClaims() });
  claims.recordHistory("C1", { session_id: "sess-X", channel_name: "rc-demo" });
  claims.claim("peerA", "C1", { channelName: "rc-demo", sessionId: "sess-X" });

  claims.release("peerA");

  assert.deepEqual(claims.history("C1"), { session_id: "sess-X", channel_name: "rc-demo" });
  assert.equal(isRemoteChannel(claims, "C1"), true, "a once-seized rc channel is still remote after release");
  assert.equal(isRemoteChannel(claims, "C-never"), false, "a channel never seized takes the normal path");
});

test("a channel seized under a non-rc name is not a remote channel", async () => {
  const claims = createClaimsStore({ path: tmpClaims() });
  claims.recordHistory("C-ops", { session_id: "sess-Y", channel_name: "ops" });
  assert.equal(isRemoteChannel(claims, "C-ops"), false, "only an rc- record keeps the rc rules after release");
});

// The 30 s timer used to drop dead claims silently. It now runs the sweep, and
// reapDead is gone so nothing can quietly reintroduce the silent path.
test("the daemon sweep replaced claims.reapDead", () => {
  assert.equal(createClaimsStore({ path: tmpClaims() }).reapDead, undefined, "reapDead must be gone from the store");
  const src = fs.readFileSync(fileURLToPath(new URL("../../bin/claude-slack.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(src, /reapDead/, "the timer must not reap silently");
  assert.match(src, /sweepClaims\(\{ broker, claims, web, log \}\)/, "the timer runs the disconnect sweep");
});
