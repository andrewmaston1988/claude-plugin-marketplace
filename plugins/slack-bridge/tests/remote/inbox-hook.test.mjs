// Mid-turn delivery: the sync PostToolBatch hook hands a claimed session its queued
// Slack messages as context on the tool result. A tmp stateDir and a fake client,
// then the real entry through a spawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInboxHook } from "../../src/remote/inbox-hook.mjs";
import { PRIMING_LINE } from "../../src/remote/waiter.mjs";

const SID = "sess-1";
const PEER = "peer-a";
const pluginFile = (rel) => fileURLToPath(new URL("../../" + rel, import.meta.url));
const entry = pluginFile("hooks/inbox-hook.mjs");
const input = (extra = {}) => JSON.stringify({ session_id: SID, hook_event_name: "PostToolBatch", ...extra });
const MESSAGES = [{ id: 1, text: "stop that" }, { id: 2, text: "and this" }];

function setup(t, { claimed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(path.join(stateDir, "remote-sessions"), { recursive: true });
  if (claimed) {
    fs.writeFileSync(path.join(stateDir, "remote-sessions", SID + ".json"), JSON.stringify({ peerId: PEER, configPath: "cfg.json" }));
  }
  return { dir, stateDir };
}

function fakeClient({ messages = MESSAGES, takeThrows = false } = {}) {
  const log = [];
  return {
    log,
    async takeLeased(id) {
      log.push("take:" + id);
      if (takeThrows) throw new Error("fetch failed");
      return { messages, ack: async () => { log.push("ack"); } };
    },
  };
}

function run(env, { client = fakeClient(), raw = input(), out, connects = [] } = {}) {
  const written = [];
  return runInboxHook({
    raw,
    stateDir: env.stateDir,
    out: out ?? (async (s) => { client.log.push("out"); written.push(s); }),
    _connect: async (session) => { connects.push(session); return client; },
  }).then(() => ({ written, client, connects }));
}

test("queued messages go out as PostToolBatch context, in the wake's own wording", async (t) => {
  const { written } = await run(setup(t));
  assert.deepEqual(JSON.parse(written.join("")), {
    hookSpecificOutput: {
      hookEventName: "PostToolBatch",
      additionalContext: `${PRIMING_LINE}\nSLACK: stop that\nSLACK: and this\n`,
    },
  });
});

test("it takes for the peer the claim names, through the claim's config", async (t) => {
  const { client, connects } = await run(setup(t));
  assert.equal(client.log[0], "take:" + PEER);
  assert.equal(connects[0].configPath, "cfg.json");
});

test("the ack follows the write: a lost write has to redeliver", async (t) => {
  const { client } = await run(setup(t));
  assert.deepEqual(client.log.slice(1), ["out", "ack"]);
});

test("a failed write acks nothing and never throws", async (t) => {
  const client = fakeClient();
  await run(setup(t), { client, out: async () => { throw new Error("EPIPE"); } });
  assert.ok(!client.log.includes("ack"), client.log.join());
});

test("nothing queued writes nothing and acks nothing", async (t) => {
  const { written, client } = await run(setup(t), { client: fakeClient({ messages: [] }) });
  assert.deepEqual(written, []);
  assert.ok(!client.log.includes("ack"), client.log.join());
});

test("an unclaimed session touches no broker", async (t) => {
  const { connects } = await run(setup(t, { claimed: false }));
  assert.deepEqual(connects, []);
});

// Sync, on every tool batch: a fixed exit delay holds the next model request for its
// whole length, and the awaited write and ack leave the natural exit nothing to lose.
test("the entry exits on its own, with no exit timer", () => {
  const src = fs.readFileSync(entry, "utf8");
  assert.doesNotMatch(src, /setTimeout|process\.exit/);
});

test("a subagent's tool leaves the message for the main conversation", async (t) => {
  const { connects, written } = await run(setup(t), { raw: input({ agent_id: "agent-7", agent_type: "Explore" }) });
  assert.deepEqual(connects, []);
  assert.deepEqual(written, []);
});

test("a session started with --agent carries agent_type alone and still gets its messages", async (t) => {
  const { written } = await run(setup(t), { raw: input({ agent_type: "reviewer" }) });
  assert.equal(written.length, 1);
});

test("bad stdin or a dead broker writes nothing and never throws", async (t) => {
  const env = setup(t);
  assert.deepEqual((await run(env, { raw: "not json" })).written, []);
  assert.deepEqual((await run(env, { client: fakeClient({ takeThrows: true }) })).written, []);
});

test("hooks.json runs the inbox hook synchronously on every tool batch, with a bound", () => {
  const groups = JSON.parse(fs.readFileSync(pluginFile("hooks/hooks.json"), "utf8")).hooks.PostToolBatch;
  const match = groups.flatMap((g) => g.hooks)
    .filter((h) => /hooks\/inbox-hook\.mjs"$/.test(h.command ?? ""));
  assert.equal(match.length, 1);
  assert.ok(!match[0].async && !match[0].asyncRewake, "async context waits for the next turn");
  assert.ok(match[0].timeout > 0 && match[0].timeout <= 15, String(match[0].timeout));
});

test("the entry exits clean with no output for an unclaimed session", (t) => {
  const { dir } = setup(t);
  const r = spawnSync(process.execPath, [entry], {
    input: input(),
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, LOCALAPPDATA: dir, XDG_STATE_HOME: dir, HOME: dir, USERPROFILE: dir },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
});

// Runs on every tool in every session: what the unclaimed path imports is its cost.
test("the unclaimed path statically reaches neither the config nor the broker client", () => {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, spec] of fs.readFileSync(file, "utf8").matchAll(/^import [^"]*"(\.[^"]+)"/gm)) {
      walk(fileURLToPath(new URL(spec, "file:///" + file.replaceAll("\\", "/"))));
    }
  };
  walk(entry);
  const reached = [...seen].map((f) => path.basename(f));
  assert.ok(reached.includes("session-file.mjs"), reached.join());
  for (const heavy of ["config.mjs", "broker-client.mjs", "broker.mjs", "stop-hook.mjs"]) {
    assert.ok(!reached.includes(heavy), heavy + " in " + reached.join());
  }
});
