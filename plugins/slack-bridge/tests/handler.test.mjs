import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMessage, loadDedup, safeUpdate, startBridge, postStartupNotification, postResponse, postError } from "../src/core/handler.mjs";
import { createQueue } from "../src/core/queue.mjs";

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

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
  return {
    get: k => data[k],
    set: (k, v) => { data[k] = v; },
    delete: k => { delete data[k]; },
    all: () => ({ ...data }),
    _data: data,
  };
}

function makeWeb({ postTs = "ts1", updateError } = {}) {
  const calls = [];
  const web = {
    calls,
    chatPostMessage: async p => { calls.push(["post", p]); return { ts: postTs, ok: true }; },
    chatUpdate: async p => {
      calls.push(["update", p]);
      if (updateError) throw updateError;
      return {};
    },
    chatDelete: async p => { calls.push(["delete", p]); return {}; },
    authTest: async () => ({ user_id: "U123", team_id: "T1" }),
  };
  return web;
}

function makeSocket() {
  const handlers = {};
  return {
    on(evt, fn) { handlers[evt] = fn; return this; },
    start() {},
    _handlers: handlers,
  };
}

test("handler — skips bot messages", async () => {
  const log = makeLog();
  const web = makeWeb();
  const queue = createQueue({ log });
  const store = makeStore();
  const config = { slack: {}, claude: { cwd: "/tmp", timeout: 5000 } };

  await handleMessage({
    web, store, queue, config, log,
    payload: { type: "message", channel: "C1", text: "hi", bot_id: "B1" },
    botUserId: "U123", isFirstInSession: true,
  });
  await delay(50);
  assert.equal(web.calls.length, 0, "bot message should be skipped");
});

test("handler — skip logs the reason", async () => {
  const log = makeLog();
  const web = makeWeb();
  const queue = createQueue({ log });
  const store = makeStore();
  const config = { slack: {}, claude: { cwd: "/tmp", timeout: 5000 } };

  await handleMessage({
    web, store, queue, config, log,
    payload: { type: "message", channel: "C1", text: "hi", bot_id: "B1" },
    botUserId: null, isFirstInSession: true,
  });
  await delay(50);
  const skipLog = log.entries.find(e => e[0] === "info" && e[1] === "message skipped");
  assert.ok(skipLog, "should log skip event");
  assert.equal(skipLog[2].reason, "bot_message");
});

test("handler — skips message_changed subtype", async () => {
  const log = makeLog();
  const web = makeWeb();
  const queue = createQueue({ log });
  const store = makeStore();
  const config = { slack: {}, claude: { cwd: "/tmp", timeout: 5000 } };

  await handleMessage({
    web, store, queue, config, log,
    payload: { type: "message", channel: "C1", text: "hi", subtype: "message_changed" },
    botUserId: null, isFirstInSession: true,
  });
  await delay(50);
  assert.equal(web.calls.length, 0, "message_changed should be skipped");
});

test("handler — skips empty text after mention strip", async () => {
  const log = makeLog();
  const web = makeWeb();
  const queue = createQueue({ log });
  const store = makeStore();
  const config = { slack: {}, claude: { cwd: "/tmp", timeout: 5000 } };

  await handleMessage({
    web, store, queue, config, log,
    payload: { type: "message", channel: "C1", text: "<@U123>" },
    botUserId: "U123", isFirstInSession: true,
  });
  await delay(50);
  assert.equal(web.calls.length, 0, "empty text after mention strip should be skipped");
});

test("handler — skips duplicate client_msg_id", async () => {
  const log = makeLog();
  const web = makeWeb();
  const queue = createQueue({ log });
  const store = makeStore();
  const config = { slack: {}, claude: { cwd: "/tmp", timeout: 5000 } };

  const payload = { type: "message", channel: "C1", text: "hi", client_msg_id: "msg-dedup-test" };

  await handleMessage({ web, store, queue, config, log, payload, botUserId: null, isFirstInSession: true });
  const countAfterFirst = web.calls.length;
  await handleMessage({ web, store, queue, config, log, payload, botUserId: null, isFirstInSession: false });
  await delay(50);
  assert.ok(countAfterFirst <= web.calls.length, "second identical msg_id should not enqueue additional calls");
});

test("handler — dedup IDs restored from store on loadDedup", async () => {
  // Simulate restart: store already has a dedup entry from previous run.
  const preloadedId = `restored-${Date.now()}-${Math.random()}`;
  const store = makeStore({ "__dedup__": [preloadedId] });
  loadDedup(store);

  const log = makeLog();
  const web = makeWeb();
  const queue = createQueue({ log });
  const config = { slack: {}, claude: { cwd: "/tmp", timeout: 5000 } };

  await handleMessage({
    web, store, queue, config, log,
    payload: { type: "message", channel: "C-restore", text: "hi", client_msg_id: preloadedId },
    botUserId: null, isFirstInSession: true,
  });
  await delay(50);
  assert.equal(web.calls.length, 0, "ID loaded from store should be treated as duplicate");
  const skipLog = log.entries.find(e => e[0] === "info" && e[2]?.reason === "dedup");
  assert.ok(skipLog, "should log dedup skip");
});

test("handler — onlyChannel config filters other channels", async () => {
  const log = makeLog();
  const web = makeWeb();
  const queue = createQueue({ log });
  const store = makeStore();
  const config = { slack: { onlyChannel: "C-ALLOWED" }, claude: { cwd: "/tmp", timeout: 5000 } };

  await handleMessage({
    web, store, queue, config, log,
    payload: { type: "message", channel: "C-OTHER", text: "hi", client_msg_id: "abc-filter" },
    botUserId: null, isFirstInSession: true,
  });
  await delay(50);
  assert.equal(web.calls.length, 0, "message to non-allowed channel should be skipped");
});

test("handler — posts placeholder on valid message", async () => {
  const log = makeLog();
  const web = makeWeb({ postTs: "placeholder-ts" });
  const queue = createQueue({ log });
  const store = makeStore();
  const config = { slack: {}, claude: { cwd: "/tmp", timeout: 100 } };

  await handleMessage({
    web, store, queue, config, log,
    payload: { type: "message", channel: "C1", text: "hello world", client_msg_id: "m-placeholder" },
    botUserId: null, isFirstInSession: true,
  });
  await delay(100);
  const postCalls = web.calls.filter(([type]) => type === "post");
  assert.ok(postCalls.length >= 1, "should have posted a placeholder");
  assert.equal(postCalls[0][1].channel, "C1");
});

// safeUpdate tests

test("safeUpdate — calls chatUpdate on success", async () => {
  const web = makeWeb();
  await safeUpdate({ web, channel: "C1", ts: "ts1", params: { text: "done" }, threadTs: null });
  assert.equal(web.calls.length, 1);
  assert.equal(web.calls[0][0], "update");
  assert.equal(web.calls[0][1].ts, "ts1");
  assert.equal(web.calls[0][1].text, "done");
});

test("safeUpdate — falls back to chatPostMessage on message_not_found", async () => {
  const err = Object.assign(new Error("not found"), { slackError: "message_not_found" });
  const web = makeWeb({ updateError: err });
  await safeUpdate({ web, channel: "C2", ts: "ts2", params: { text: "fallback" }, threadTs: null });
  assert.equal(web.calls.length, 2, "should have tried update then post");
  assert.equal(web.calls[0][0], "update");
  assert.equal(web.calls[1][0], "post");
  assert.equal(web.calls[1][1].text, "fallback");
  assert.equal(web.calls[1][1].channel, "C2");
  assert.ok(!("ts" in web.calls[1][1]), "chatPostMessage should not include ts");
});

test("safeUpdate — falls back to chatPostMessage on cant_update_message", async () => {
  const err = Object.assign(new Error("cant update"), { slackError: "cant_update_message" });
  const web = makeWeb({ updateError: err });
  await safeUpdate({ web, channel: "C3", ts: "ts3", params: { text: "x" }, threadTs: "thread1" });
  const postCall = web.calls.find(([t]) => t === "post");
  assert.ok(postCall, "should fall back to post");
  assert.equal(postCall[1].thread_ts, "thread1", "should preserve thread_ts in fallback");
});

test("safeUpdate — rethrows other Slack errors", async () => {
  const err = Object.assign(new Error("channel_not_found"), { slackError: "channel_not_found" });
  const web = makeWeb({ updateError: err });
  await assert.rejects(
    () => safeUpdate({ web, channel: "C4", ts: "ts4", params: { text: "x" }, threadTs: null }),
    { message: "channel_not_found" }
  );
});

// Regression: the historic .py bridge (_post_startup_notification) posted a
// standalone "🔄 *Bridge restarted*" Slack message to the most recent DM session
// on every startup. The mjs port dropped this — only the inject-into-claude-prompt
// path survived — so "Bridge restarted" stopped printing on restart. Restore it.

test("postStartupNotification — posts '🔄 *Bridge restarted*' to the most recent DM session", async () => {
  const log = makeLog();
  const web = makeWeb();
  // Two DM sessions (bare channel ids, no ":") + one threaded channel session.
  const store = makeStore({ "D111": "s1", "C222:thread": "s2", "D333": "s3" });
  await postStartupNotification({ web, store, log });
  const restartPosts = web.calls.filter(([t, p]) => t === "post" && p.text === "🔄 *Bridge restarted*");
  assert.equal(restartPosts.length, 1, "should post exactly one restart notification");
  assert.equal(restartPosts[0][1].channel, "D333", "should target the most recent DM session (last bare-id key)");
});

test("postStartupNotification — posts nothing when there are no DM sessions", async () => {
  const log = makeLog();
  const web = makeWeb();
  const store = makeStore({ "C222:thread": "s2" }); // threaded only, no bare-id DM keys
  await postStartupNotification({ web, store, log });
  const restartPosts = web.calls.filter(([t, p]) => t === "post" && p.text === "🔄 *Bridge restarted*");
  assert.equal(restartPosts.length, 0, "no DM session → no restart notification");
});

test("postStartupNotification — a failed post is swallowed (startup must not abort)", async () => {
  const log = makeLog();
  const web = makeWeb();
  web.chatPostMessage = async () => { throw new Error("slack down"); };
  const store = makeStore({ "D111": "s1" });
  await assert.doesNotReject(() => postStartupNotification({ web, store, log }));
  const warnLog = log.entries.find(e => e[0] === "warn");
  assert.ok(warnLog, "should log a warning on failure");
});

test("startBridge — posts '🔄 *Bridge restarted*' to the most recent DM session on startup", async () => {
  const log = makeLog();
  const web = makeWeb();
  const queue = createQueue({ log });
  const store = makeStore({ "D111": "s1", "C222:thread": "s2", "D333": "s3" });
  const config = { slack: {}, claude: { cwd: "/tmp", timeout: 5000 } };
  const socket = makeSocket();
  await startBridge({ config, log, web, socket, store, queue, extensions: null });
  await delay(50);
  const restartPosts = web.calls.filter(([t, p]) => t === "post" && p.text === "🔄 *Bridge restarted*");
  assert.equal(restartPosts.length, 1, "startBridge should post one restart notification");
  assert.equal(restartPosts[0][1].channel, "D333", "should target the most recent DM session");
});

// Regression: the .py posted the reply as the clean message BODY
// (chat_update text=response_text, attachments=progress_only) and the error as
// plain text (text="_Error: …_", attachments=[]). The mjs port wrapped the whole
// reply inside a Slack attachment (text:"" + attachments:[{text: mrkdwn}]) so the
// entire reply rendered inside the "|" attachment bar, and the error likewise.
// Restore the .py recipe: reply/error are the message text; no body-wrapping attachment.

test("postResponse — posts reply as clean message text, NOT wrapped in an attachment", async () => {
  const web = makeWeb();
  await postResponse({ web, channel: "C1", placeholderTs: "ph1", threadTs: null,
    responseText: "Here is the reply body.", existingSession: "s1", isFirstInSession: false, cmdEcho: "hi" });
  const updateCalls = web.calls.filter(([t]) => t === "update");
  assert.ok(updateCalls.length >= 1, "should update the placeholder with the reply");
  const upd = updateCalls[updateCalls.length - 1][1];
  assert.equal(upd.text, "Here is the reply body.", "reply should be the message body text");
  assert.ok(!upd.attachments || upd.attachments.length === 0,
    "reply must NOT be wrapped in an attachment (the | bar regression)");
});

test("postResponse — first-in-session reply gets a bold title in the message text, not an attachment", async () => {
  const web = makeWeb();
  await postResponse({ web, channel: "C1", placeholderTs: "ph1", threadTs: null,
    responseText: "body text", existingSession: null, isFirstInSession: true, cmdEcho: "my title" });
  const upd = web.calls.find(([t]) => t === "update")[1];
  assert.ok(upd.text.includes("*my title*"), "bold title should be in the message text");
  assert.ok(!upd.attachments || upd.attachments.length === 0, "no attachment wrapping the body");
});

test("postResponse — long reply splits into multiple plain-text posts, none wrapped in an attachment", async () => {
  const web = makeWeb();
  const long = "a".repeat(2000) + "\n\n" + "b".repeat(2000); // two paras → splitResponse makes 2 chunks
  await postResponse({ web, channel: "C1", placeholderTs: "ph1", threadTs: null,
    responseText: long, existingSession: "s1", isFirstInSession: false, cmdEcho: "hi" });
  assert.ok(web.calls.some(([t]) => t === "delete"), "should delete the placeholder");
  const posts = web.calls.filter(([t]) => t === "post");
  assert.ok(posts.length >= 2, "should post multiple chunks");
  for (const [, p] of posts) {
    assert.equal(typeof p.text, "string");
    assert.ok(p.text.length > 0, "each chunk should be message text");
    assert.ok(!p.attachments || p.attachments.length === 0, "no chunk wrapped in an attachment");
  }
});

test("postError — posts the error as plain text, no attachment", async () => {
  const web = makeWeb();
  await postError({ web, channel: "C1", placeholderTs: "ph1", threadTs: null, message: "boom" });
  const upd = web.calls.find(([t]) => t === "update")[1];
  assert.equal(upd.text, "_Error: boom_");
  assert.ok(!upd.attachments || upd.attachments.length === 0, "error must not be wrapped in an attachment");
});
