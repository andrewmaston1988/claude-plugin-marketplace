// Harness for the live-route integration tests: a fake broker, web and heartbeat
// around a started reply loop.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleMessage, startReplyLoop, _resetRouteState } from "../../src/core/handler.mjs";
import { createQueue } from "../../src/core/queue.mjs";
import { createClaimsStore } from "../../src/remote/claims.mjs";

export { waitFor } from "./helpers.mjs";

export function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
export function tmpClaims() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "route-claims-")), "claims.json"); }

export function makeLog() {
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
export function makeStore(initial = {}) {
  const data = { ...initial };
  return { get: (k) => data[k], set: (k, v) => { data[k] = v; }, delete: (k) => { delete data[k]; }, all: () => ({ ...data }) };
}
// Every placeholder gets its own ts so a test can tell which window a reply
// resolved. `calls` is the single ordered log the heartbeat also writes to.
// `latencyMs(k)` delays the kth call and records it when it lands, as Slack does.
export function makeWeb({ latencyMs = () => 0 } = {}) {
  const calls = [];
  let n = 0;
  let k = 0;
  // No await at all when there is no lag: an extra tick would reorder the other tests.
  const lag = () => { const ms = latencyMs(k++); return ms ? delay(ms) : null; };
  return {
    calls,
    // `_ts` is the ts Slack returns for the new message — not part of the request,
    // but a test has to know which message a later chat.update targeted.
    chatPostMessage: async (p) => { const w = lag(); if (w) await w; const ts = `ph-${++n}`; calls.push(["post", { ...p, _ts: ts }]); return { ts, ok: true }; },
    chatUpdate: async (p) => { const w = lag(); if (w) await w; calls.push(["update", p]); return {}; },
    chatDelete: async (p) => { const w = lag(); if (w) await w; calls.push(["delete", p]); return {}; },
    authTest: async () => ({ user_id: "U123", team_id: "T1" }),
  };
}
export function makeRunClaude(result = "spawn-mode reply") {
  const calls = [];
  const fn = (opts) => { calls.push(opts); return Promise.resolve({ result, sessionId: "s1" }); };
  return { fn, calls };
}
// Injected heartbeat: records start/setTool/stop into the same ordered log as the
// web calls, so "heartbeat stopped before the reply landed" is an index compare.
export function makeHeartbeat(calls) {
  const instances = [];
  function start({ startedAt, channel, ts, cmdEcho, extensions }) {
    const rec = { startedAt, channel, ts, cmdEcho, extensions, tools: [], statuses: [], stopped: false, stopCalls: 0 };
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
export function makeFakeBroker({ alive = new Set(), failWaits = 0, down = false } = {}) {
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

export function makePayload({ channel, text = "", subtype, client_msg_id }) {
  return { type: "message", channel, text, subtype, client_msg_id };
}

// One routed/claimed channel with a live peer, a started reply loop, and the
// injected heartbeat — everything a routing test needs. `t.after` stops the loop.
export function setup(t, { replyTimeoutMs = 3000, claims: preClaims = [], alive: aliveOverride, quietGapMs = 1000, down = false, latencyMs } = {}) {
  _resetRouteState();
  const claims = createClaimsStore({ path: tmpClaims() });
  for (const [peer, channel] of preClaims) claims.claim(peer, channel);
  // By default every claimed peer is live; a test passes `alive: []` to kill them.
  const alive = aliveOverride ?? preClaims.map(([peer]) => peer);
  const broker = makeFakeBroker({ alive: new Set(alive), down });
  const web = makeWeb({ latencyMs });
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
export async function slack(s, payload, { runClaude, extensions = null } = {}) {
  return handleMessage({
    web: s.web, store: makeStore({ [payload.channel]: { model: "sonnet" } }), queue: s.queue, config: s.config, log: s.log,
    payload, botUserId: "U123", isFirstInSession: true,
    remote: { claims: s.claims, broker: s.broker },
    extensions, _runClaude: runClaude?.fn, _startHeartbeat: s.hb.start,
  });
}

export const hasPost = (web, needle) => web.calls.some(([t, p]) => t === "post" && typeof p.text === "string" && p.text.includes(needle));
// The state blocks are attachments, so a plain-text search misses them.
export const posted = (web, needle) => web.calls.some(([t, p]) => t === "post"
  && (String(p.text ?? "").includes(needle)
    || (p.attachments ?? []).some((a) => String(a.text ?? "").includes(needle))));
export const hasUpdate = (web, needle) => web.calls.some(([t, p]) => t === "update" && typeof p.text === "string" && p.text.includes(needle));
export const idxOf = (web, pred) => web.calls.findIndex(pred);
export const placeholderTss = (web) =>
  web.calls.filter(([ty, p]) => ty === "post" && p.attachments?.[0]?.color === "#808080").map(([, p]) => p._ts);
