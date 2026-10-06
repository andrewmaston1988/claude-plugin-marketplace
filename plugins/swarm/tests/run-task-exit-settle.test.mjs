import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runTask, makeDefaultIo } from "../src/scheduler.mjs";
import { CFG, task } from "./helpers/scheduler-fixtures.mjs";

const terminal = `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" })}\n`;
function childIo(emit) {
  const child = new EventEmitter();
  child.pid = 1234;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const io = {
    spawn: () => { setTimeout(() => emit(child), 0); return child; },
    fetch: async () => ({ ok: true }), now: () => Date.now(), freeMemMb: () => Infinity,
    stdout: () => {}, snapshot: () => {}, maxLines: 0, env: process.env,
  };
  return { io, child };
}
const run = (io, timeoutMs = 1000) => runTask(task("exit-settle", { timeoutMs }), "go", CFG, io, null, {});

test("exit without close drains the terminal stdout and settles", { timeout: 500 }, async () => {
  const { io } = childIo((child) => {
    child.stdout.emit("data", terminal);
    child.emit("exit", 0);
  });
  const result = await run({ ...io, exitDrainMs: 20 });
  equal(result.ok, true);
});

test("timeout settles when neither exit nor close arrives", { timeout: 500 }, async () => {
  const { io } = childIo(() => {});
  const result = await run({ ...io, exitDrainMs: 15 }, 20);
  equal(result.timedOut, true);
  equal(result.ok, false);
});

test("exit drain preserves stdout that arrives before close", { timeout: 500 }, async () => {
  const { io } = childIo((child) => {
    child.emit("exit", 0);
    setTimeout(() => child.stdout.emit("data", terminal), 5);
    setTimeout(() => child.emit("close", 0), 10);
  });
  const result = await run({ ...io, exitDrainMs: 50 });
  equal(result.ok, true);
  equal(result.raw, terminal, "stdout emitted after exit must be parsed before close settles");
});

test("close wins without destroying either stream", { timeout: 500 }, async () => {
  let destroyed = 0;
  const { io } = childIo((child) => {
    child.stdout.destroy = () => destroyed++;
    child.stderr.destroy = () => destroyed++;
    child.stdout.emit("data", terminal);
    child.emit("exit", 0);
    child.emit("close", 0);
  });
  const result = await run({ ...io, exitDrainMs: 20 });
  equal(result.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  equal(destroyed, 0);
});

test("error after exit settles as a spawn error", { timeout: 500 }, async () => {
  const { io } = childIo((child) => {
    child.emit("exit", 0);
    const error = new Error("spawn failed");
    error.code = "ENOENT";
    child.emit("error", error);
  });
  const result = await run({ ...io, exitDrainMs: 30 });
  equal(result.ok, false);
  equal(result.errorCode, "ENOENT");
});

test("timeout kills the tree and preserves an exit code during drain", { timeout: 500 }, async () => {
  let killed;
  // exit lands at 25 ms, INSIDE a drain the 10 ms timeout already armed.
  const { io } = childIo((child) => setTimeout(() => child.emit("exit", 9), 25));
  const result = await run({ ...io, exitDrainMs: 60, killTree: (child) => { killed = child; } }, 10);
  ok(killed);
  equal(result.timedOut, true);
  equal(result.exit, 9);
  equal(makeDefaultIo().exitDrainMs, 2000);
});

// The exit lands well inside the run and the deadline passes well after it: a
// 5 ms/15 ms pair rounds into the same coarse Windows timer tick and the
// deadline wins about half the time, which tests the clock rather than the guard.
test("an exit before the deadline settles as success, never as a timeout", { timeout: 2000 }, async () => {
  let killCalls = 0;
  const { io } = childIo((child) => {
    child.stdout.emit("data", terminal);
    setTimeout(() => child.emit("exit", 0), 5);
  });
  const result = await run({ ...io, exitDrainMs: 250, killTree: () => { killCalls++; } }, 100);
  equal(result.ok, true);
  ok(!result.timedOut);
  equal(result.exit, 0);
  equal(killCalls, 0);
});

test("Windows default tree kill uses taskkill recursively and forcibly", () => {
  let call;
  const io = makeDefaultIo({ platform: "win32", spawnSync: (...args) => { call = args; } });
  io.killTree({ pid: 73, kill() { throw new Error("must use taskkill"); } });
  deepEqual(call[0], "taskkill");
  deepEqual(call[1], ["/PID", "73", "/T", "/F"]);
  deepEqual(call[2], { stdio: "ignore", windowsHide: true, timeout: 5000 });
});
