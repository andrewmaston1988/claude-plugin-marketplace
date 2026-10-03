import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMessage, startBridge } from "../src/core/handler.mjs";
import { createQueue } from "../src/core/queue.mjs";
import { delay, makeLog, makeStore, makeWeb, makeSocket } from "./fakes.mjs";

const HINT = "No model set for this channel — type /model <name>, e.g. /model sonnet.";

function makeRunClaude() {
  const calls = [];
  const fn = async opts => { calls.push(opts); return { result: "ok", sessionId: "S-new" }; };
  fn.calls = calls;
  return fn;
}

let n = 0;
async function send({ store, payload = {}, remote, config = { slack: {}, claude: { cwd: "/tmp", timeout: 100 } } }) {
  const log = makeLog();
  const web = makeWeb();
  const runClaude = makeRunClaude();
  await handleMessage({
    web, store, queue: createQueue({ log }), config, log, remote,
    payload: { type: "message", channel: "C1", text: "hi", client_msg_id: `mg-${++n}`, ...payload },
    botUserId: null, isFirstInSession: false, _runClaude: runClaude,
  });
  await delay(50);
  return { web, runClaude, posts: web.calls.filter(([t]) => t === "post").map(([, p]) => p) };
}

async function slash(store, command, text = "") {
  const web = makeWeb();
  const socket = makeSocket();
  const log = makeLog();
  startBridge({ config: { slack: {}, claude: {} }, log, web, socket, store, queue: createQueue({ log }) });
  socket._handlers.slash_command({ payload: { command, text, channel_id: "C1" }, ack() {} });
  await delay(50);
  return web.calls.filter(([t]) => t === "post").map(([, p]) => p.text);
}

// --- gate ---

test("gate — unclaimed channel with no model posts the hint and spawns nothing", async () => {
  const { runClaude, posts } = await send({ store: makeStore() });
  assert.equal(runClaude.calls.length, 0);
  assert.deepEqual(posts.map(p => p.text), [HINT]);
});

test("gate — the hint lands in the message's thread", async () => {
  const { posts } = await send({ store: makeStore(), payload: { thread_ts: "111.1" } });
  assert.equal(posts[0].text, HINT);
  assert.equal(posts[0].thread_ts, "111.1");
});

test("gate — a legacy bare-string session is gated", async () => {
  const { runClaude } = await send({ store: makeStore({ C1: "legacy-sess" }) });
  assert.equal(runClaude.calls.length, 0);
});

// --- spawn model ---

test("spawn — passes the channel model, not config.claude.model", async () => {
  const store = makeStore({ C1: { model: "glm-5.2:cloud" } });
  const config = { slack: {}, claude: { cwd: "/tmp", timeout: 100, model: "opus" } };
  const { runClaude } = await send({ store, config });
  assert.equal(runClaude.calls.length, 1);
  assert.equal(runClaude.calls[0].model, "glm-5.2:cloud");
});

test("spawn — stores the session as an object, keeping the model", async () => {
  const store = makeStore({ C1: { model: "sonnet" } });
  await send({ store });
  assert.deepEqual(store._data.C1, { model: "sonnet", sessionId: "S-new" });
});

test("spawn — a thread session inherits the channel model and resumes its own session", async () => {
  const store = makeStore({ C1: { model: "sonnet", sessionId: "S-chan" }, "C1:222.2": { sessionId: "S-thread" } });
  const { runClaude } = await send({ store, payload: { thread_ts: "222.2" } });
  assert.equal(runClaude.calls[0].model, "sonnet");
  assert.equal(runClaude.calls[0].sessionId, "S-thread");
});

// --- claim bypass ---

function claimed(isAlive) {
  const released = [];
  return {
    released,
    claims: { get: () => ({ peer_id: "P1" }), release: async id => { released.push(id); } },
    broker: { isAlive },
  };
}

test("claim — broker unreachable, no model: spawns with model omitted, no hint", async () => {
  const remote = claimed(async () => { throw new Error("ECONNREFUSED"); });
  const { runClaude, posts } = await send({ store: makeStore(), remote });
  assert.equal(runClaude.calls.length, 1);
  assert.equal(runClaude.calls[0].model, undefined);
  assert.ok(!posts.some(p => p.text === HINT));
});

test("claim — peer dead, no model: claim reaped, hint posted, no spawn", async () => {
  const remote = claimed(async () => false);
  const { runClaude, posts } = await send({ store: makeStore(), remote });
  assert.deepEqual(remote.released, ["P1"]);
  assert.equal(runClaude.calls.length, 0);
  assert.deepEqual(posts.map(p => p.text), [HINT]);
});

// --- /model ---

test("/model <name> stores the model on the channel key and confirms", async () => {
  const store = makeStore();
  const posts = await slash(store, "/model", "sonnet");
  assert.deepEqual(store._data.C1, { model: "sonnet" });
  assert.ok(posts.includes("Model set: sonnet"));
});

test("/model with no argument reports the current model, or none", async () => {
  assert.ok((await slash(makeStore(), "/model")).includes("Model: none"));
  assert.ok((await slash(makeStore({ C1: { model: "opus" } }), "/model")).includes("Model: opus"));
});

test("/model — switching Claude ↔ non-Claude drops sessionId on the channel and its threads", async () => {
  const store = makeStore({ C1: { model: "sonnet", sessionId: "S" }, "C1:1.1": { sessionId: "T" }, C2: { sessionId: "X" } });
  await slash(store, "/model", "glm-5.2:cloud");
  assert.deepEqual(store._data.C1, { model: "glm-5.2:cloud" });
  assert.equal("C1:1.1" in store._data, false);
  assert.deepEqual(store._data.C2, { sessionId: "X" }, "other channels untouched");
});

test("/model — rejects a name that is not a plain model id, storing nothing", async () => {
  for (const bad of ["sonnet & calc", "a|b", "x\"y", "-p", "opus %PATH%"]) {
    const store = makeStore({ C1: { model: "sonnet" } });
    const posts = await slash(store, "/model", bad);
    assert.deepEqual(store._data.C1, { model: "sonnet" }, `stored ${bad}`);
    assert.ok(posts.some(t => t.startsWith("Invalid model name")), `no rejection for ${bad}`);
  }
});

test("/model — switching within the Claude side keeps sessionId", async () => {
  const store = makeStore({ C1: { model: "sonnet", sessionId: "S" } });
  await slash(store, "/model", "opus");
  assert.deepEqual(store._data.C1, { model: "opus", sessionId: "S" });
});

// --- /new ---

test("/new clears sessionId and keeps the model", async () => {
  const store = makeStore({ C1: { model: "sonnet", sessionId: "S" } });
  await slash(store, "/new");
  assert.deepEqual(store._data.C1, { model: "sonnet" });
});
