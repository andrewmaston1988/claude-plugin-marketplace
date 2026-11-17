import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createCodexAppServerClient } from "../src/codex-app-server.mjs";

// Block the loop past the request deadline so an already-queued stdin error can
// only win if the deadline yields a turn. Must sit between issuing and awaiting:
// after `await`, the error has already landed and there is no race to exercise.
function stall(ms) {
  const started = Date.now();
  while (Date.now() - started < ms) { /* busy wait */ }
}

function childWithAsyncStdinError() {
  const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      setImmediate(() => callback(error));
    },
  });
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {},
  });
}

// Holds the write callback so the test decides when stdin fails. A failure the child
// schedules itself lands in whichever loop phase the test body happened to start in,
// which makes the ordering between the deadline and the error depend on the runner.
function childHoldingWrite() {
  const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  const writes = [];
  const stdin = new Writable({
    write(_chunk, _encoding, callback) { writes.push(callback); },
  });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {},
  });
  return { child, failHeldWrite: () => writes.shift()(error) };
}

function childWithLateStdinError(delayMs) {
  const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      setTimeout(() => callback(error), delayMs);
    },
  });
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {},
  });
}

function childWithSilentStdin() {
  return Object.assign(new EventEmitter(), {
    stdin: new Writable({ write() {} }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {},
  });
}

function healthyChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {},
  });
}

test("a stdin error queued before the deadline wins over a stalled timeout", async () => {
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  const client = createCodexAppServerClient({
    timeoutMs: 30,
    spawnImpl: childWithAsyncStdinError,
  });
  let requestError;
  try {
    const request = client.request("account/usage/read");
    stall(40);
    await request.catch((error) => { requestError = error; });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("uncaughtException", onUncaught);
    client.close();
  }
  deepEqual({ requestError: requestError?.code, uncaught: uncaught.map((error) => error.code) }, {
    requestError: "EPIPE",
    uncaught: [],
  });
});

// Due after the 30 ms request deadline, so both are timers and Node runs them in
// deadline order inside one timers phase. An immediate instead lands in whatever loop
// phase the runner started the body in, and loses to the deadline on the un-deferred
// source, which leaves the test green on the code it exists to catch.
const HELD_WRITE_FAILURE_MS = 35;

test("both in-flight requests reject with the stdin error across a stall", async () => {
  let held;
  const client = createCodexAppServerClient({
    timeoutMs: 30,
    spawnImpl: () => (held = childHoldingWrite()).child,
  });
  try {
    const first = client.request("account/usage/read");
    const second = client.request("account/rateLimits/read");
    setTimeout(held.failHeldWrite, HELD_WRITE_FAILURE_MS);
    stall(40);
    const errors = await Promise.all([
      first.catch((error) => error),
      second.catch((error) => error),
    ]);
    deepEqual(errors.map((error) => error.code), ["EPIPE", "EPIPE"]);
  } finally {
    client.close();
  }
});

test("a reply landing in the yield window resolves the request and leaves the client open", async () => {
  let child;
  const spawnImpl = () => {
    // A timer, not an immediate: the deadline (30 ms) and the reply (35 ms) both
    // expire during the stall, so the timer phase orders them regardless of which
    // loop phase the test body started in. An immediate can be drained first.
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        setTimeout(() => {
          const message = JSON.parse(String(chunk));
          if (message.method === "account/usage/read") {
            child.stdout.push(`${JSON.stringify({ id: message.id, result: { ok: true } })}\n`);
          }
          callback();
        }, 35);
      },
    });
    child = Object.assign(new EventEmitter(), {
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {},
    });
    return child;
  };
  const client = createCodexAppServerClient({ timeoutMs: 30, spawnImpl });
  try {
    const answered = client.request("account/usage/read");
    const slow = client.request("account/rateLimits/read", {}, { requestTimeoutMs: 5000 });
    // `slow` must stay outstanding; it is rejected by the cleanup close below.
    slow.catch(() => {});
    stall(40);
    deepEqual(await answered, { ok: true });
    // A microtask is not enough: the deferred deadline sits in the check phase, so
    // yield into the loop before reading whether the client survived it.
    await new Promise((resolve) => setImmediate(resolve));
    equal(client.diagnostics.closed, false);
    equal(client.diagnostics.killed, false);
    equal(client.diagnostics.pending, 1);
  } finally {
    client.close();
  }
});

test("a write that never calls back still times out", async () => {
  const client = createCodexAppServerClient({
    timeoutMs: 30,
    spawnImpl: childWithSilentStdin,
  });
  try {
    const started = Date.now();
    const request = client.request("account/usage/read");
    stall(40);
    const error = await request.catch((caught) => caught);
    equal(error.code, "ETIMEDOUT");
    equal(Date.now() - started < 1000, true);
  } finally {
    client.close();
  }
});

// Hundreds of ms past the deadline, not the 20 the first version left: a 40 ms
// busy-wait can be preempted by a scheduler jitter of that size, and a resume inside
// the window lets the stdin EPIPE win the race this test exists to order.
const LATE_STDIN_ERROR_MS = 300;

test("a stdin error after close is recorded and a plain double close records nothing", async () => {
  const client = createCodexAppServerClient({
    timeoutMs: 30,
    spawnImpl: () => childWithLateStdinError(LATE_STDIN_ERROR_MS),
  });
  try {
    const request = client.request("account/usage/read");
    stall(40);
    const error = await request.catch((caught) => caught);
    equal(error.code, "ETIMEDOUT");
    await new Promise((resolve) => setTimeout(resolve, LATE_STDIN_ERROR_MS));
    equal(client.diagnostics.lateErrors.length, 1);
    equal(client.diagnostics.lateErrors[0].code, "EPIPE");
  } finally {
    client.close();
  }

  const healthy = createCodexAppServerClient({ spawnImpl: healthyChild });
  healthy.close();
  healthy.close();
  deepEqual(healthy.diagnostics.lateErrors, []);
});
