// Background waiter loop: window looping, retry/backoff, output. A fake client
// and an injected clock/sleep stand in for the broker — no network, no waiting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWaiter, waitFooter } from "../../src/remote/waiter.mjs";
import { WAIT_CAP_MS, WAIT_WINDOW_MS, BASH_TIMEOUT_MS, waitCommand } from "../../src/remote/wait-constants.mjs";
import { getPaths } from "../../src/paths.mjs";

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
      return Promise.resolve({ messages: step.map((text) => ({ from_id: "slack-bridge", text, kind: "text" })) });
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
    _now: () => t,
    _sleep: async (ms) => { sleeps.push(ms); },
    ...extra,
  });
  return { client, sleeps, run, output: () => output };
}

const reset = (msg) => Object.assign(new Error(`read ${msg}`), { code: msg });

test("message on window 3 → prints SLACK line + footer with the exact waitCommand, returns 0", async () => {
  const h = harness([[], [], ["hello from phone"]]);
  const code = await h.run();
  assert.equal(code, 0);
  assert.equal(h.client.calls.length, 3);
  assert.match(h.output(), /^SLACK: hello from phone$/m);
  assert.ok(h.output().includes(waitCommand("p1")), h.output());
  assert.ok(h.output().includes(String(BASH_TIMEOUT_MS)));
});

test("every message in the batch is printed", async () => {
  const h = harness([["one", "two"]]);
  assert.equal(await h.run(), 0);
  assert.match(h.output(), /SLACK: one\nSLACK: two\n/);
});

test("ECONNRESET twice then a message → returns 0 with the message, retry count 2", async () => {
  const h = harness([reset("ECONNRESET"), reset("ECONNRESET"), ["after reconnect"]]);
  const code = await h.run();
  assert.equal(code, 0);
  assert.match(h.output(), /SLACK: after reconnect/);
  assert.deepEqual(h.sleeps, [1000, 2000], "two backoff sleeps, doubling");
});

test("backoff caps at 30 s", async () => {
  const errs = Array.from({ length: 8 }, () => reset("ECONNREFUSED"));
  const h = harness([...errs, ["x"]], { stepMs: 1 });
  assert.equal(await h.run(), 0);
  assert.equal(Math.max(...h.sleeps), 30_000);
  assert.deepEqual(h.sleeps.slice(0, 6), [1000, 2000, 4000, 8000, 16000, 30000]);
});

test("401 → returns 2, output names remote.controlToken", async () => {
  const h = harness([new Error("Broker error (/wait): 401 unauthorized")]);
  assert.equal(await h.run(), 2);
  assert.match(h.output(), /remote\.controlToken/);
});

test("404 from a pre-/wait broker → fatal, not a silent 2 h retry loop", async () => {
  const h = harness([new Error("Broker error (/wait): 404 not found")]);
  assert.equal(await h.run(), 1);
  assert.equal(h.client.calls.length, 1);
});

test("clock passes WAIT_CAP_MS → WAIT EXPIRED, returns 0; cap < Bash timeout", async () => {
  const h = harness([]);
  const code = await h.run();
  assert.equal(code, 0);
  assert.match(h.output(), /WAIT EXPIRED after [\d.]+h — re-arm: /);
  assert.ok(h.output().includes(waitCommand("p1")));
  assert.equal(h.client.calls.length, Math.ceil(WAIT_CAP_MS / WAIT_WINDOW_MS));
  assert.ok(WAIT_CAP_MS < BASH_TIMEOUT_MS);
});

// The mock hang holds no handle, so an unref'd AbortSignal.timeout lets the loop
// drain and the test is cancelled before the abort fires (seen on Linux CI).
const refdTimeout = (ms) => () => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };

test("a window whose fetch never settles is aborted, counted as a retry, the loop continues (A5)", async () => {
  const h = harness(["hang", ["late message"]], { _signal: refdTimeout(20) });
  const code = await h.run();
  assert.equal(code, 0);
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

test("footer has the agreed literal and no slack_post (A6)", () => {
  const f = waitFooter("p1");
  assert.ok(!/slack_post/.test(f), f);
  assert.equal(
    f,
    `Reply normally — your text is mirrored to Slack. Then re-arm: run ${waitCommand("p1")} with run_in_background and timeout ${BASH_TIMEOUT_MS}.`,
  );
});

test("a non-default configPath rides into the footer's command (A9)", async () => {
  const custom = "C:/elsewhere/custom.json";
  const h = harness([["hi"]], { configPath: custom });
  await h.run();
  assert.ok(h.output().includes(`--config "${custom}"`), h.output());
});

test("waitCommand: non-default config carries --config, default carries none (A9)", () => {
  assert.match(waitCommand("p1", { configPath: "/tmp/other.json" }), /--config "\/tmp\/other\.json"/);
  assert.ok(!waitCommand("p1", { configPath: getPaths().configDir + "/config.json" }).includes("--config"));
  assert.ok(!waitCommand("p1").includes("--config"));
});
