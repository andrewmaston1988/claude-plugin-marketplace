// asyncRewake Stop hook: reads the claim, runs the waiter, writes its text to
// stderr. A tmp stateDir, a fake client and an injected waiter — no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRewakeHook } from "../../src/remote/rewake-hook.mjs";
import { HOOK_TIMEOUT_MS, WAIT_CAP_MS, WAIT_WINDOW_MS } from "../../src/remote/wait-constants.mjs";

const SID = "sess-1";
const PEER = "peer-a";
const hooksJson = fileURLToPath(new URL("../../hooks/hooks.json", import.meta.url));

function setup(t, { claimed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rewake-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, "state");
  const configPath = path.join(dir, "custom-config.json");
  const sessionFile = path.join(stateDir, "remote-sessions", `${SID}.json`);
  const claim = (peerId = PEER) => {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify({ peerId, configPath, channel: "rc-test" }));
  };
  if (claimed) claim();
  return { stateDir, configPath, sessionFile, claim };
}

function fakeClient({ peers = [PEER], fail = false, healthThrows = false } = {}) {
  const listOpts = [];
  return {
    listOpts,
    health: async () => {
      if (healthThrows) throw new Error("bridge down");
      return { status: "ok", lease: true, single_flight: true };
    },
    ensureBroker: async () => {},
    async listPeers(opts, fetchOpts) {
      listOpts.push({ opts, fetchOpts });
      if (fail) throw new Error("fetch failed");
      return peers.map((id) => ({ id }));
    },
  };
}

function run(env, { client = fakeClient(), raw, loads, creates, runner = async () => 0, signal } = {}) {
  return runRewakeHook({
    raw: raw ?? JSON.stringify({ session_id: SID, hook_event_name: "Stop" }),
    stateDir: env.stateDir,
    _loadConfig: ({ configPath }) => { loads?.push(configPath); return { remote: { brokerPort: 1, controlToken: "tok" } }; },
    _createClient: (opts) => { creates?.push(opts); return client; },
    _runWaiter: runner,
    _signal: signal,
  });
}

// Swaps the process streams for sinks, so a test can read what the hook wrote.
function captureStreams() {
  const origErr = Object.getOwnPropertyDescriptor(process, "stderr");
  const origOut = Object.getOwnPropertyDescriptor(process, "stdout");
  const sink = (log) => ({ write: (s, cb) => { log.push(String(s)); cb?.(); return true; }, once() {}, off() {} });
  const errs = [];
  const outs = [];
  Object.defineProperty(process, "stderr", { value: sink(errs), configurable: true });
  Object.defineProperty(process, "stdout", { value: sink(outs), configurable: true });
  return {
    errs,
    outs,
    restore: () => {
      Object.defineProperty(process, "stderr", origErr);
      Object.defineProperty(process, "stdout", origOut);
    },
  };
}

// Captures what runRewakeHook hands the waiter, so stillNeeded can be driven by hand.
const capture = () => {
  const seen = {};
  return { seen, runner: async (opts) => { Object.assign(seen, opts); return 0; } };
};

test("no session file → 0 with no config load and no broker call", async (t) => {
  const env = setup(t, { claimed: false });
  const loads = [];
  const creates = [];
  let ran = 0;
  const code = await run(env, { loads, creates, runner: async () => { ran++; return 2; } });
  assert.equal(code, 0);
  assert.deepEqual(loads, []);
  assert.deepEqual(creates, []);
  assert.equal(ran, 0);
});

test("bad JSON on stdin → 0", async (t) => {
  const env = setup(t);
  const loads = [];
  assert.equal(await run(env, { raw: "{not json", loads }), 0);
  assert.deepEqual(loads, []);
});

test("claimed → runs the waiter for the claim's peer with the claim's config, returns its code", async (t) => {
  const env = setup(t);
  const loads = [];
  const creates = [];
  const { seen, runner } = capture();
  const code = await run(env, { loads, creates, runner: async (o) => { await runner(o); return 2; } });
  assert.equal(code, 2);
  assert.equal(seen.peerId, PEER);
  assert.deepEqual(loads, [env.configPath]);
  assert.deepEqual(creates, [{ port: 1, token: "tok", configPath: env.configPath }]);
  assert.equal(typeof seen.stillNeeded, "function");
});

test("claimed → the waiter's text reaches stderr, not stdout", async (t) => {
  const env = setup(t);
  const io = captureStreams();
  try {
    await run(env, { runner: async ({ out }) => { await out("SLACK: hi\n"); return 2; } });
  } finally {
    io.restore();
  }
  assert.deepEqual(io.errs, ["SLACK: hi\n"]);
  assert.deepEqual(io.outs, []);
});

test("a load failure after the claim is found writes WAIT FAILED and wakes (2)", async (t) => {
  const cases = [
    ["config load", { _loadConfig: () => { throw new Error("bad config"); } }],
    ["client build", { _createClient: () => { throw new Error("no port"); } }],
    ["prepareBroker", { _createClient: () => fakeClient({ healthThrows: true }) }],
  ];
  for (const [label, overrides] of cases) {
    const env = setup(t);
    const io = captureStreams();
    let ran = 0;
    try {
      const code = await runRewakeHook({
        raw: JSON.stringify({ session_id: SID }),
        stateDir: env.stateDir,
        _loadConfig: () => ({ remote: { brokerPort: 1, controlToken: "tok" } }),
        _createClient: () => fakeClient(),
        _runWaiter: async () => { ran++; return 0; },
        ...overrides,
      });
      assert.equal(code, 2, `${label}: a claimed session must wake, not fall silent`);
    } finally {
      io.restore();
    }
    assert.deepEqual(io.errs, [`WAIT FAILED: ${label === "prepareBroker" ? "bridge down" : label === "config load" ? "bad config" : "no port"}\n`], label);
    assert.deepEqual(io.outs, [], label);
    assert.equal(ran, 0, label);
  }
});

test("stillNeeded is true while the file names this peer and the peer row is live", async (t) => {
  const env = setup(t);
  const { seen, runner } = capture();
  await run(env, { runner });
  assert.equal(await seen.stillNeeded(), true);
});

// A half-open socket on listPeers would hang the waiter into the silent hook
// timeout, so the lookup carries a 5 s abort signal.
test("stillNeeded gives listPeers a 5 s abort signal", async (t) => {
  const env = setup(t);
  const client = fakeClient();
  const signal = { name: "timeout" };
  const timeouts = [];
  const { seen, runner } = capture();
  await run(env, { runner, client, signal: (ms) => { timeouts.push(ms); return signal; } });
  assert.equal(await seen.stillNeeded(), true);
  assert.deepEqual(timeouts, [5000]);
  assert.deepEqual(client.listOpts, [{ opts: {}, fetchOpts: { signal } }]);
});

test("stillNeeded is false once the session file is gone", async (t) => {
  const env = setup(t);
  const { seen, runner } = capture();
  await run(env, { runner });
  fs.rmSync(env.sessionFile);
  assert.equal(await seen.stillNeeded(), false);
});

test("stillNeeded is false once the peer row is reaped", async (t) => {
  const env = setup(t);
  const { seen, runner } = capture();
  await run(env, { runner, client: fakeClient({ peers: ["other"] }) });
  assert.equal(await seen.stillNeeded(), false);
});

test("stillNeeded is false when a re-seize rewrote the file to a different peer", async (t) => {
  const env = setup(t);
  const { seen, runner } = capture();
  await run(env, { runner, client: fakeClient({ peers: [PEER, "peer-b"] }) });
  env.claim("peer-b");
  assert.equal(await seen.stillNeeded(), false);
});

test("a listPeers failure leaves stillNeeded true", async (t) => {
  const env = setup(t);
  const { seen, runner } = capture();
  await run(env, { runner, client: fakeClient({ fail: true }) });
  assert.equal(await seen.stillNeeded(), true);
});

test("hooks.json Stop runs rewake-hook with asyncRewake, and its timeout matches HOOK_TIMEOUT_MS", () => {
  const stop = JSON.parse(fs.readFileSync(hooksJson, "utf8")).hooks.Stop.flatMap((g) => g.hooks);
  const rewake = stop.filter((h) => /claude-slack\.mjs" rewake-hook$/.test(h.command ?? ""));
  assert.equal(rewake.length, 1, JSON.stringify(stop));
  assert.equal(rewake[0].type, "command");
  assert.equal(rewake[0].asyncRewake, true);
  assert.equal(rewake[0].timeout * 1000, HOOK_TIMEOUT_MS);
  assert.ok(stop.some((h) => / stop-hook$/.test(h.command ?? "") && !h.asyncRewake), "the sync mirror entry stays");
});

test("the cap clears the hook timeout by more than one worst loop iteration", () => {
  const worstIteration = (WAIT_WINDOW_MS + 10_000) + 6_000 + 30_000;
  assert.ok(HOOK_TIMEOUT_MS - WAIT_CAP_MS > worstIteration, `${HOOK_TIMEOUT_MS} - ${WAIT_CAP_MS} <= ${worstIteration}`);
});
