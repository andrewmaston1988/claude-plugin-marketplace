// A claimed session as Claude Code drives it, for any build of this plugin: a real
// broker and daemon loaded from that build's root, and a hook dispatcher that fires
// whatever that build's hooks.json registers for each event. Only Slack is faked.
// The same scenario can then run against master and the branch.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runEntry } from "../run-entry.mjs";
import { makeHeartbeat, makeLog, makePayload, makeStore, makeWeb, liveBlocks, delay } from "../integration/route-harness.mjs";

export const SID = "sess-1";
// Slack answers at once, so a cell's outcome repeats; races that need a slow Slack
// call are pinned with makeWeb's latency in the integration tests.
const QUIET_MS = 100;

// The daemon dedupes Slack message ids across the process, so ids never repeat.
let nextMsg = 0;

const load = (root, rel) => import(pathToFileURL(path.join(root, rel)).href);

// Shell-style split, enough for the commands hooks.json carries.
const tokens = (command) => [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);

// hooks.json matchers are regexes on the tool name, or a notification's type; "*" or
// none matches every one.
const matches = (matcher, toolName) => !matcher || matcher === "*" || new RegExp(`^(?:${matcher})$`).test(toolName ?? "");

export async function startSession(root) {
  const { createBroker } = await load(root, "src/remote/broker.mjs");
  const { createBrokerClient } = await load(root, "src/remote/broker-client.mjs");
  const { createClaimsStore } = await load(root, "src/remote/claims.mjs");
  const { createQueue } = await load(root, "src/core/queue.mjs");
  const { handleMessage, startReplyLoop, _resetRouteState } = await load(root, "src/core/handler.mjs");
  const hooks = JSON.parse(fs.readFileSync(path.join(root, "hooks/hooks.json"), "utf8")).hooks;

  _resetRouteState();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-"));
  const broker = createBroker({ stateFile: path.join(dir, "broker.json") });
  const port = await broker.listen(0);
  const call = async (p, body) => (await fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })).json();
  const peer = (await call("/register", { pid: process.pid, cwd: dir, git_root: dir, tty: null, summary: "sim" })).id;

  const stateDir = path.join(dir, "claude-slack");
  fs.mkdirSync(path.join(stateDir, "remote-sessions"), { recursive: true });
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ tokens: { bot: "x", app: "x" }, claude: { cwd: dir }, remote: { brokerPort: port } }));
  fs.writeFileSync(path.join(stateDir, "remote-sessions", `${SID}.json`), JSON.stringify({ peerId: peer, configPath }));
  const env = { LOCALAPPDATA: dir, XDG_STATE_HOME: dir, HOME: dir, USERPROFILE: dir, APPDATA: dir };
  const transcript = path.join(dir, "t.jsonl");
  fs.writeFileSync(transcript, "");

  const claims = createClaimsStore({ path: path.join(dir, "claims.json") });
  claims.claim(peer, "C1");
  const web = makeWeb();
  const hb = makeHeartbeat(web.calls);
  const log = makeLog();
  const config = { slack: {}, claude: { cwd: dir, timeout: 1000 }, remote: {} };
  const client = createBrokerClient({ port, _spawn: () => { throw new Error("sim tried to spawn a broker"); } });
  const loop = startReplyLoop({ broker: client, claims, web, config, log, _quietGapMs: QUIET_MS, _startHeartbeat: hb.start });
  const queue = createQueue({ log: makeLog() });

  const spawned = [];
  const running = new Set(); // async hooks not yet exited, waiters aside
  const trace = [];        // every hook run: event, entry, exit, how long, stderr
  const wakes = [];        // stderr of every waiter that exited 2, in order
  const deliveries = [];   // every text the session was handed: { how, text }

  // Fires one Claude Code hook event: every matching entry starts together, as the
  // docs say; sync entries are awaited, async ones run on, asyncRewake ones are
  // waiters whose exit 2 is a wake.
  async function fire(event, extra = {}) {
    const input = { session_id: SID, transcript_path: transcript, hook_event_name: event, ...extra };
    const sync = [];
    for (const group of hooks[event] ?? []) {
      if (!matches(group.matcher, extra.tool_name ?? extra.notification_type)) continue;
      for (const h of group.hooks ?? []) {
        const [cmd, ...rest] = tokens(h.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", root));
        if (cmd !== "node") continue;
        const p = runEntry(rest, env, input);
        spawned.push(p);
        const entry = { at: Date.now(), event, args: rest.slice(1).join(" ") };
        trace.push(entry);
        p.then((r) => Object.assign(entry, { status: r.status, ms: Date.now() - entry.at, stderr: r.stderr.slice(0, 160) }));
        if (h.asyncRewake) {
          p.then((r) => { if (r.status === 2) { wakes.push(r.stderr); deliveries.push({ how: "wake", text: r.stderr }); } });
        } else if (!h.async) {
          sync.push(p);
        } else {
          running.add(p);
          p.then(() => running.delete(p));
        }
      }
    }
    const results = await Promise.all(sync);
    for (const r of results) {
      if (r.stdout.includes("additionalContext")) deliveries.push({ how: "in-turn", text: r.stdout });
    }
    return results;
  }

  const s = {
    root, web, hb, log, wakes, deliveries, trace,
    append: (...entries) => fs.appendFileSync(transcript, entries.map((e) => JSON.stringify(e) + "\n").join("")),
    fire,
    send: (text) => handleMessage({
      web, store: makeStore({ C1: { model: "sonnet" } }), queue, config, log,
      payload: makePayload({ channel: "C1", text, client_msg_id: `sim-${++nextMsg}` }), botUserId: "U123", isFirstInSession: true,
      remote: { claims, broker: client }, _startHeartbeat: hb.start,
    }),
    liveBlocks: () => liveBlocks(web),
    ticking: () => hb.instances.filter((i) => !i.stopped).length,
    settle: () => delay(QUIET_MS * 4),
    // Every async hook started so far has exited; the waiters are not counted.
    hooksDone: () => Promise.all([...running]),
    stop: async () => {
      for (const p of spawned) p.child.kill();
      await Promise.all(spawned);
      loop.stop();
      await loop.done;
      await broker.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return s;
}
