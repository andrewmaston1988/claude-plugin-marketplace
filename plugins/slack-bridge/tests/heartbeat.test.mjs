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
