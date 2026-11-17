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

test("both in-flight requests reject with the stdin error across a stall", async () => {
  let held;
  const client = createCodexAppServerClient({
    timeoutMs: 30,
    spawnImpl: () => (held = childHoldingWrite()).child,
  });
  try {
    const first = client.request("account/usage/read");
    const second = client.request("account/rateLimits/read");
    stall(40);
    setImmediate(held.failHeldWrite);
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
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        setImmediate(() => {
          const message = JSON.parse(String(chunk));
          if (message.method === "account/usage/read") {
            child.stdout.push(`${JSON.stringify({ id: message.id, result: { ok: true } })}\n`);
          }
          callback();
        });
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
    stall(40);
    deepEqual(await answered, { ok: true });
    equal(client.diagnostics.closed, false);
    equal(client.diagnostics.killed, false);
    equal(client.diagnostics.pending, 1);
    // `slow` must stay outstanding; awaiting it would hang this row.
    slow.catch(() => {});
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

test("a stdin error after close is recorded and a plain double close records nothing", async () => {
  const client = createCodexAppServerClient({
    timeoutMs: 30,
    spawnImpl: () => childWithLateStdinError(60),
  });
  try {
    const request = client.request("account/usage/read");
    stall(40);
    const error = await request.catch((caught) => caught);
    equal(error.code, "ETIMEDOUT");
    await new Promise((resolve) => setTimeout(resolve, 40));
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
