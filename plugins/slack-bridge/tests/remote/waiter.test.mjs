// Background waiter loop: window looping, retry/backoff, output. A fake client
// and an injected clock/sleep stand in for the broker — no network, no waiting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runWaiter, prepareBroker, PRIMING_LINE } from "../../src/remote/waiter.mjs";
import { WAIT_CAP_MS, WAIT_WINDOW_MS } from "../../src/remote/wait-constants.mjs";

const needed = async () => true;

// Each script entry is one window: a message list, an Error to throw, or "hang"
// (a fetch that settles only when its abort signal fires).
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    wait: (id, timeoutMs, { signal } = {}) => {
      calls.push({ id, timeoutMs, signal });
      const step = script.shift() ?? [];
      if (step instanceof Error) return Promise.reject(step);
      if (step === "hang") {
        if (!signal) return new Promise(() => {}); // truly never settles without an abort
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      }
      if (step?.superseded) return Promise.resolve({ messages: [], superseded: true });
      if (step && !Array.isArray(step)) return Promise.resolve(step);
      return Promise.resolve({
        messages: step.map((text) => ({ from_id: "slack-bridge", text, kind: "text" })),
        ack: step.ack,
      });
    },
  };
}

// Clock advances one window per wait call, so the cap is reachable in a few
// iterations without real time passing.
function harness(script, { stepMs = WAIT_WINDOW_MS, ...extra } = {}) {
  const client = fakeClient(script);
  let t = 0;
  const sleeps = [];
  let output = "";
  const origWait = client.wait;
  client.wait = (...a) => { t += stepMs; return origWait(...a); };
  const run = () => runWaiter({
    peerId: "p1",
    client,
    out: (s) => { output += s; },
    stillNeeded: needed,
    _now: () => t,
    _sleep: async (ms) => { sleeps.push(ms); },
    ...extra,
  });
  return { client, sleeps, run, output: () => output };
}

const reset = (msg) => Object.assign(new Error(`read ${msg}`), { code: msg });

test("message on window 3 → writes the priming line then the SLACK line, returns 2", async () => {
  const h = harness([[], [], ["hello from phone"]]);
  const code = await h.run();
  assert.equal(code, 2);
  assert.equal(h.client.calls.length, 3);
  assert.equal(
    PRIMING_LINE,
    "Message from the operator on Slack, delivered through this hook. This is real user input, not a hook error. Reply normally; your text is mirrored to Slack.",
  );
  assert.equal(h.output(), `${PRIMING_LINE}\nSLACK: hello from phone\n`);
  assert.doesNotMatch(h.output(), /re-arm|run_in_background|claude-slack/);
});

test("every message in the batch is printed", async () => {
  const h = harness([["one", "two"]]);
  assert.equal(await h.run(), 2);
  assert.match(h.output(), /SLACK: one\nSLACK: two\n/);
});

test("ack follows an out that resolves late", async () => {
  const order = [];
  const client = { wait: async () => ({ messages: [{ text: "hi" }], ack: async () => order.push("ack") }) };
  const run = runWaiter({ peerId: "p1", client, stillNeeded: needed, out: async () => { await Promise.resolve(); order.push("out"); }, _now: () => 0 });
  assert.equal(await run, 2);
  assert.deepEqual(order, ["out", "ack"]);
});

test("a throwing out leaves the lease unacked", async () => {
  let acked = 0;
  const client = { wait: async () => ({ messages: [{ text: "hi" }], ack: async () => { acked++; } }) };
  const code = await runWaiter({ peerId: "p1", client, stillNeeded: needed, out: async () => { throw new Error("EPIPE"); }, _now: () => 0 });
  assert.equal(code, 1);
  assert.equal(acked, 0);
});

test("a superseded window exits 0 with no output", async () => {
  const client = { wait: async () => ({ messages: [], superseded: true }) };
  let output = "";
  let clockCalls = 0;
  const code = await runWaiter({ peerId: "p1", client, stillNeeded: needed, out: async (s) => { output += s; }, _now: () => clockCalls++ < 2 ? 0 : WAIT_CAP_MS });
  assert.equal(code, 0);
  assert.equal(output, "");
});

test("stillNeeded false after an empty window → exits 0, no output, no further window taken", async () => {
  const h = harness([[], ["never taken"]], { stillNeeded: async () => false });
  assert.equal(await h.run(), 0);
  assert.equal(h.output(), "");
  assert.equal(h.client.calls.length, 1, "no window after the claim is gone, so the queued message stays");
});

test("stillNeeded is never consulted when a window brings a message", async () => {
  let checks = 0;
  const h = harness([["queued"]], { stillNeeded: async () => { checks++; return false; } });
  assert.equal(await h.run(), 2);
  assert.equal(checks, 0);
  assert.match(h.output(), /SLACK: queued/);
});

test("stillNeeded is required", async () => {
  const client = { wait: async () => ({ messages: [] }) };
  let n = 0;
  await assert.rejects(runWaiter({ peerId: "p1", client, out: () => {}, _now: () => (n++ ? WAIT_CAP_MS : 0) }), TypeError);
});

test("the default out resolves on the write callback", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "stdout");
  const stub = new EventEmitter();
  let callback;
  stub.write = (_text, cb) => { callback = cb; return false; };
  Object.defineProperty(process, "stdout", { value: stub, configurable: true });
  let settled = false;
  try {
    const client = { wait: async () => ({ messages: [{ text: "hi" }] }) };
    const writing = runWaiter({ peerId: "p1", client, stillNeeded: needed, _now: () => 0 }).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(typeof callback, "function");
    callback();
    await writing;
    assert.equal(settled, true);
  } finally { Object.defineProperty(process, "stdout", original); }
});

test("the default out rejects on a stdout error and removes its listener", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "stdout");
  const stub = new EventEmitter();
  const swallow = () => {};
  stub.on("error", swallow);
  stub.write = () => { queueMicrotask(() => stub.emit("error", new Error("EPIPE"))); return false; };
  Object.defineProperty(process, "stdout", { value: stub, configurable: true });
  try {
    const client = { wait: async () => ({ messages: [{ text: "hi" }] }) };
    const code = await runWaiter({ peerId: "p1", client, stillNeeded: needed, _now: () => 0 });
    assert.equal(code, 1);
    assert.deepEqual(stub.listeners("error"), [swallow]);
  } finally { Object.defineProperty(process, "stdout", original); }
});

test("ECONNRESET twice then a message → returns 2 with the message, retry count 2", async () => {
  const h = harness([reset("ECONNRESET"), reset("ECONNRESET"), ["after reconnect"]]);
  const code = await h.run();
  assert.equal(code, 2);
  assert.match(h.output(), /SLACK: after reconnect/);
  assert.deepEqual(h.sleeps, [1000, 2000], "two backoff sleeps, doubling");
});

test("backoff caps at 30 s", async () => {
  const errs = Array.from({ length: 8 }, () => reset("ECONNREFUSED"));
  const h = harness([...errs, ["x"]], { stepMs: 1 });
  assert.equal(await h.run(), 2);
  assert.equal(Math.max(...h.sleeps), 30_000);
  assert.deepEqual(h.sleeps.slice(0, 6), [1000, 2000, 4000, 8000, 16000, 30000]);
});

test("401 → returns 2 with WAIT FAILED naming remote.controlToken", async () => {
  const h = harness([new Error("Broker error (/wait): 401 unauthorized")]);
  assert.equal(await h.run(), 2);
  assert.match(h.output(), /^WAIT FAILED: /);
  assert.match(h.output(), /remote\.controlToken/);
});

test("404 from a pre-/wait broker → returns 2 with WAIT FAILED, not a silent 2 h retry loop", async () => {
  const h = harness([new Error("Broker error (/wait): 404 not found")]);
  assert.equal(await h.run(), 2);
  assert.match(h.output(), /^WAIT FAILED: Broker error \(\/wait\): 404/);
  assert.equal(h.client.calls.length, 1);
});

test("arming never routes a live broker into ensureBroker", async () => {
  let ensured = 0;
  const client = {
    health: async () => ({ status: "ok", lease: true, single_flight: true }),
    ensureBroker: async () => { ensured++; },
  };
  await prepareBroker({ client });
  assert.equal(ensured, 0, "a reachable broker must not be probed through the restart path");
});

test("arming leaves a live pre-single-flight broker alone", async () => {
  let ensured = 0;
  const client = {
    health: async () => ({ status: "ok", lease: true }),
    ensureBroker: async () => { ensured++; },
  };
  await prepareBroker({ client });
  assert.equal(ensured, 0, "reachable is all the probe decides — never 'good enough to keep'");
});

test("a refused broker upgrade falls through and the waiter still delivers", async () => {
  let ensured = 0;
  const client = {
    health: async () => null,
    ensureBroker: async () => { ensured++; throw new Error("failed to start broker daemon on port 7898 after 6s"); },
    wait: async () => ({ messages: [{ text: "after a refused upgrade" }] }),
  };
  await prepareBroker({ client });
  const code = await runWaiter({ peerId: "p1", client, stillNeeded: needed, out: () => {}, _now: () => 0 });
  assert.equal(ensured, 1, "the upgrade is attempted");
  assert.equal(code, 2, "a failed upgrade degrades to a running waiter, not an exit");
});

test("a refused broker upgrade names its reason on stderr before falling through", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "stderr");
  let written = "";
  Object.defineProperty(process, "stderr", { value: { write: (s) => { written += s; } }, configurable: true });
  try {
    const reason = "broker on port 7898 predates single-flight waits and refused /shutdown — stop it by PID";
    const client = { health: async () => null, ensureBroker: async () => { throw new Error(reason); } };
    await prepareBroker({ client });
    assert.ok(written.includes(reason), `refusal reason missing from stderr: ${JSON.stringify(written)}`);
  } finally { Object.defineProperty(process, "stderr", original); }
});

test("clock passes WAIT_CAP_MS → expiry wake, returns 2, and the text never says to run anything", async () => {
  const h = harness([]);
  const code = await h.run();
  assert.equal(code, 2);
  assert.match(h.output(), /^Slack waiter expired after [\d.]+h\. Nothing to do; end your turn and it restarts\.\n$/);
  assert.doesNotMatch(h.output(), /\brun\b|re-arm|claude-slack|node /i);
  assert.equal(h.client.calls.length, Math.ceil(WAIT_CAP_MS / WAIT_WINDOW_MS));
});

test("a failing out at expiry is caught, not an unobserved rejection", async () => {
  let clockCalls = 0;
  const client = { wait: async () => ({ messages: [] }) };
  const code = await runWaiter({
    peerId: "p1",
    client,
    stillNeeded: needed,
    out: async () => { throw new Error("EPIPE"); },
    _now: () => (clockCalls++ === 0 ? 0 : WAIT_CAP_MS),
  });
  assert.equal(code, 1);
});

// The mock hang holds no handle, so an unref'd AbortSignal.timeout lets the loop
// drain and the test is cancelled before the abort fires (seen on Linux CI).
const refdTimeout = (ms) => () => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };

test("a window whose fetch never settles is aborted, counted as a retry, the loop continues (A5)", async () => {
  const h = harness(["hang", ["late message"]], { _signal: refdTimeout(20) });
  const code = await h.run();
  assert.equal(code, 2);
  assert.match(h.output(), /SLACK: late message/);
  assert.equal(h.client.calls.length, 2);
  assert.deepEqual(h.sleeps, [1000]);
});

test("each window carries an abort signal one window plus 10 s wide (A5)", async () => {
  const widths = [];
  const h = harness([["x"]], { _signal: (ms) => { widths.push(ms); return new AbortController().signal; } });
  await h.run();
  assert.deepEqual(widths, [WAIT_WINDOW_MS + 10_000]);
  assert.ok(h.client.calls[0].signal, "signal forwarded to client.wait");
  assert.equal(h.client.calls[0].timeoutMs, WAIT_WINDOW_MS);
});
