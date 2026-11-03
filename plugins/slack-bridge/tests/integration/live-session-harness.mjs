// A claimed session driven through the real hook entry points, a real broker and the
// reply loop, with only Slack faked. Shared by the whole-turn replays and the matrix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startReplyLoop, _resetRouteState } from "../../src/core/handler.mjs";
import { createQueue } from "../../src/core/queue.mjs";
import { createBrokerClient } from "../../src/remote/broker-client.mjs";
import { createClaimsStore } from "../../src/remote/claims.mjs";
import { REG, claimedSession, runEntry, startBroker } from "../remote/broker-harness.mjs";
import { textEntry, userEntry } from "../remote/stop-hook-harness.mjs";
import { delay, makeHeartbeat, makeLog, makePayload, makeWeb, placeholderTss, slack, tmpClaims } from "./route-harness.mjs";

export const SID = "sess-1";
export const QUIET = 100;
const pluginFile = (rel) => fileURLToPath(new URL("../../" + rel, import.meta.url));
const bin = pluginFile("bin/claude-slack.mjs");
const inboxEntry = pluginFile("hooks/inbox-hook.mjs");
export const BASH = { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "tb1" };
export const LINT = { tool_name: "Bash", tool_input: { command: "npm run lint" }, tool_use_id: "tb2" };
// Slack ids are deduped across the process, so each send needs its own.
let nextId = 0;

// A block is live until a reply lands in it or it is deleted.
export const liveBlocks = (web) => placeholderTss(web)
  .filter((ts) => !web.calls.some(([ty, p]) => (ty === "update" || ty === "delete") && p.ts === ts));
export const label = (s) => s.hb.instances.at(-1)?.statuses.at(-1);

// runEntry, keeping the child so a test can kill a waiter that never leaves.
function spawnEntry(args, env, input) {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  child.stdin.end(JSON.stringify(input));
  return Object.assign(done, { child });
}

async function liveSession(t) {
  _resetRouteState();
  const { port, call } = await startBroker(t);
  const peer = (await call("/register", REG)).body.id;
  const env = claimedSession(t, { port, peer, sid: SID });
  const transcript = path.join(env.LOCALAPPDATA, "t.jsonl");
  fs.writeFileSync(transcript, "");

  const claims = createClaimsStore({ path: tmpClaims() });
  claims.claim(peer, "C1");
  const web = makeWeb();
  const hb = makeHeartbeat(web.calls);
  const log = makeLog();
  const config = { slack: {}, claude: { cwd: "/tmp", timeout: 1000 }, remote: { replyTimeoutMs: 60_000 } };
  // Throws rather than respawns: a test must not leave a detached broker running.
  const broker = createBrokerClient({ port, _spawn: () => { throw new Error("test tried to spawn a broker"); } });
  const loop = startReplyLoop({ broker, claims, web, config, log, _quietGapMs: QUIET, _startHeartbeat: hb.start });
  const waiters = [];

  const hook = async (args, input) => {
    const r = await runEntry(args, env, { session_id: SID, transcript_path: transcript, ...input });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  const s = {
    peer, broker, claims, web, hb, log, config, loop, call, queue: createQueue({ log: makeLog() }),
    append: (...entries) => fs.appendFileSync(transcript, entries.map((e) => JSON.stringify(e) + "\n").join("")),
    send: (text) => slack(s, makePayload({ channel: "C1", text, client_msg_id: `replay-${++nextId}` })),
    mirror: (event, input = {}) => hook([bin, "stop-hook"], { hook_event_name: event, ...input }),
    toolStart: (tool = BASH) => hook([bin, "stop-hook", "--tool-start"], { hook_event_name: "PreToolUse", ...tool }),
    inbox: () => hook([inboxEntry], { hook_event_name: "PostToolBatch" }),
    // The first hook after a seize starts the mirror here and sends nothing.
    prime: async () => {
      s.append(userEntry("u0", "before the seize"), textEntry("a0", "BEFORE THE SEIZE"));
      await s.mirror("PostToolUse");
    },
    // Claude Code starts both Stop entries together; the turn's last entry flushes
    // after them. `waiter` is the Stop's asyncRewake run: its exit and wake text.
    stop: async ({ lastMessage, flush = [], flushAfterMs = 300 } = {}) => {
      const input = { session_id: SID, transcript_path: transcript, hook_event_name: "Stop" };
      if (lastMessage) input.last_assistant_message = lastMessage;
      const waiter = spawnEntry([bin, "rewake-hook"], env, input);
      waiters.push(waiter);
      const mirror = hook([bin, "stop-hook"], input);
      await delay(flushAfterMs);
      s.append(...flush);
      await mirror;
      return { waiter };
    },
    // Ends every waiter still open: one on /wait would outlive the test.
    retireWaiters: async () => {
      for (const w of waiters) w.child.kill();
      await Promise.all(waiters);
    },
  };
  return s;
}

export const replay = (name, body) => test(name, async (t) => {
  const s = await liveSession(t);
  try {
    await body(s);
  } finally {
    await s.retireWaiters();
    // Ahead of the broker's close: a /wait that outlives it would try to respawn it.
    s.loop.stop();
    await s.loop.done;
  }
});
