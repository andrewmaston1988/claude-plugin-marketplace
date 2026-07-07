import { test } from "node:test";
import assert from "node:assert/strict";
import { startHeartbeat } from "../src/heartbeat/loop.mjs";
import { HEARTBEAT_INTERVAL_MS } from "../src/heartbeat/constants.mjs";

function makeWeb(calls) {
  return {
    chatUpdate: async params => { calls.push(params); return {}; },
  };
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

test("heartbeat — fires at interval and updates message", { timeout: HEARTBEAT_INTERVAL_MS * 4 }, async () => {
  const calls = [];
  const log = { warn: () => {} };
  const hb = startHeartbeat({ web: makeWeb(calls), channel: "C1", ts: "12345", cmdEcho: "hello", log });
  await delay(HEARTBEAT_INTERVAL_MS * 2 + 100);
  hb.stop();
  assert.ok(calls.length >= 2, `expected ≥2 calls, got ${calls.length}`);
  for (const c of calls) {
    assert.equal(c.channel, "C1");
    assert.equal(c.ts, "12345");
    assert.ok(c.attachments?.[0]?.text?.includes("hello"), "text should include cmdEcho");
  }
});

test("heartbeat — stop prevents further updates", { timeout: HEARTBEAT_INTERVAL_MS * 4 }, async () => {
  const calls = [];
  const log = { warn: () => {} };
  const hb = startHeartbeat({ web: makeWeb(calls), channel: "C2", ts: "99", cmdEcho: "x", log });
  await delay(HEARTBEAT_INTERVAL_MS + 100);
  hb.stop();
  const countAfterStop = calls.length;
  await delay(HEARTBEAT_INTERVAL_MS + 100);
  assert.equal(calls.length, countAfterStop, "no more calls after stop");
});

test("heartbeat — cycles verb and color across ticks", { timeout: HEARTBEAT_INTERVAL_MS * 5 }, async () => {
  const calls = [];
  const log = { warn: () => {} };
  const hb = startHeartbeat({ web: makeWeb(calls), channel: "C3", ts: "ts3", cmdEcho: "cmd", log });
  await delay(HEARTBEAT_INTERVAL_MS * 3 + 100);
  hb.stop();
  const colors = new Set(calls.map(c => c.attachments?.[0]?.color));
  assert.ok(colors.size > 1, "should cycle through multiple colors");
});

// Regression: the mjs port dropped the .py canon's heartbeat→reply handoff guard.
// slack_bridge.py:685-688 does `stop_hb.set(); hb_thread.join(timeout=3)` BEFORE
// posting the final reply, with the comment: "Stop heartbeat before writing final
// response — prevents race where a final heartbeat tick overwrites the response
// with the verb display." The mjs port's stop() only set a flag + clearInterval,
// so a tick already past its top-of-loop guard could land chatUpdate(text:"")
// AFTER postResponse's chatUpdate(text:<reply>) — clobbering the reply body back
// to empty and leaving only the "Processing… (elapsed)" footer + progress
// attachment. The operator saw exactly this on a "Hello" turn: claude replied
// (probe-6 returned "What can I do for you?"), no claude error in the log, but
// Slack showed only the heartbeat footer + progress. Two windows to close, both
// mirroring the .py: stop() must await the in-flight chatUpdate (the join), and a
// re-check after the pre-update awaits must drop a tick stopped mid-await.
test("heartbeat — stop() awaits the in-flight chatUpdate so it can't clobber the final reply", { timeout: HEARTBEAT_INTERVAL_MS * 2 }, async () => {
  let releaseTick;
  const tickBlocked = new Promise(r => { releaseTick = r; });
  let tickChatUpdateFired;
  const tickChatUpdateSignal = new Promise(r => { tickChatUpdateFired = r; });
  let callCount = 0;
  const web = {
    chatUpdate: async () => {
      callCount++;
      if (callCount === 1) { tickChatUpdateFired(); await tickBlocked; }
      return {};
    },
  };
  const extensions = {
    runToolVerb: async () => null,
    runHeartbeatAugment: async () => "snippet",
  };
  const log = { warn: () => {} };
  const hb = startHeartbeat({ web, channel: "CR1", ts: "ts1", cmdEcho: "hi", log, extensions, sessionId: undefined, config: {} });

  // Wait for the first tick to actually call chatUpdate (it's now in flight, blocked).
  await tickChatUpdateSignal;

  let stopResolved = false;
  const stopP = Promise.resolve(hb.stop()).then(() => { stopResolved = true; });
  await delay(50); // let microtasks settle
  // The in-flight heartbeat chatUpdate is still pending (releaseTick not called).
  // stop() must NOT resolve until that update has landed — otherwise the reply's
  // chatUpdate can be sent and land BEFORE the heartbeat's, which clobbers it.
  assert.equal(stopResolved, false, "stop() must await the in-flight heartbeat update, not resolve while it's still pending");

  releaseTick();
  await stopP;
  assert.equal(stopResolved, true, "stop() resolves once the in-flight update lands");
});

test("heartbeat — stop() during the pre-update await drops the tick (no chatUpdate, no clobber)", { timeout: HEARTBEAT_INTERVAL_MS * 2 }, async () => {
  let releaseAugment;
  const augmentBlocked = new Promise(r => { releaseAugment = r; });
  let augmentEnteredFired;
  const augmentEntered = new Promise(r => { augmentEnteredFired = r; });
  const extensions = {
    runToolVerb: async () => null,
    runHeartbeatAugment: async () => { augmentEnteredFired(); await augmentBlocked; return "snippet"; },
  };
  const calls = [];
  const web = { chatUpdate: async p => { calls.push(p); return {}; } };
  const log = { warn: () => {} };
  const hb = startHeartbeat({ web, channel: "CR2", ts: "ts2", cmdEcho: "x", log, extensions, sessionId: undefined, config: {} });

  // Wait for the first tick to enter the runHeartbeatAugment await (past the
  // top-of-loop guard, but before chatUpdate).
  await augmentEntered;
  assert.equal(calls.length, 0, "no chatUpdate before the augment await resolves");

  // stop() while the tick is blocked in the pre-update await.
  await hb.stop();
  // Releasing the augment resumes the tick. On the buggy code it proceeds to
  // chatUpdate(text:"") and clobbers a just-landed reply; on the fixed code a
  // re-check after the awaits drops it.
  releaseAugment();
  await delay(100);
  assert.equal(calls.length, 0, "a tick stopped during its pre-update await must not fire chatUpdate (it would clobber the reply)");
});

// Regression: the status template was `_${verb}${dots} ${cmdEcho} _(${elapsedStr})__`
// — four underscores with a stray `_(` mid-string and a trailing `__`. Slack mrkdwn
// can't pair them, so the underscores render LITERALLY (the `__Waiting__` symptom the
// operator saw). The fix pairs them as two clean italic spans: `_verb…_ echo _(elapsed)_`.
test("heartbeat — status text is valid Slack mrkdwn (no literal __, two balanced italic spans)", { timeout: HEARTBEAT_INTERVAL_MS * 3 }, async () => {
  const calls = [];
  const log = { warn: () => {} };
  const hb = startHeartbeat({ web: makeWeb(calls), channel: "C5", ts: "ts5", cmdEcho: "do thing", log });
  await delay(HEARTBEAT_INTERVAL_MS + 100);
  hb.stop();
  assert.ok(calls.length >= 1, "expected ≥1 heartbeat call");
  const text = calls[0].attachments?.[0]?.text;
  assert.equal(/__/.test(text), false, `status must not contain literal "__": ${JSON.stringify(text)}`);
  // Two clean italic spans: _verb…_ then plain echo then _(elapsed)_.
  assert.match(text, /^_[A-Za-z]+[^_]*_ .* _\([^)]+\)_$/, `bad mrkdwn shape: ${JSON.stringify(text)}`);
});
