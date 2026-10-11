import { test } from "node:test";
import { EventEmitter } from "node:events";
import { deepEqual, equal, ok } from "node:assert/strict";
import { runTask } from "../src/scheduler.mjs";
import { CFG, task } from "./helpers/scheduler-fixtures.mjs";

const thinking = Buffer.from('{"type":"system","subtype":"thinking_tokens","estimated_tokens":1}\n');
const resultLine = Buffer.from('{"type":"result","subtype":"success","is_error":false,"result":"done"}\n');
function fakeIo(emit) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return {
    child,
    io: {
      spawn: () => { setTimeout(() => emit(child), 0); return child; },
      fetch: async () => { throw new Error("network must not be used"); },
      now: () => Date.now(), freeMemMb: () => Infinity,
      stdout: () => {}, snapshot: () => {}, maxLines: 0, env: process.env,
    },
  };
}
function fakeLog() {
  const chunks = [];
  return {
    chunks,
    writableFinished: false,
    write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk)); },
    end(callback) { this.writableFinished = true; callback?.(); },
    bytes() { return Buffer.concat(chunks); },
  };
}
const held = async (promise) => {
  const keep = setInterval(() => {}, 1000);
  try { return await promise; } finally { clearInterval(keep); }
};

test("scheduler log drops thinking_tokens while raw and parser keep the full stdout and stderr", { timeout: 1000 }, async () => {
  const log = fakeLog();
  const stderr = Buffer.from("stderr stays\n");
  const { io } = fakeIo((child) => {
    child.stdout.emit("data", Buffer.concat([thinking, resultLine]));
    child.stderr.emit("data", stderr);
    child.emit("close", 0);
  });
  const promise = runTask(task("log-thinning", { timeoutMs: 500 }), "go", CFG, io, log, {});
  const result = await held(promise);
  deepEqual(log.bytes(), Buffer.concat([resultLine, stderr]));
  ok(result.raw.includes(thinking.toString("utf8")), "raw must retain the unfiltered thinking event");
  ok(result.raw.includes(stderr.toString("utf8")), "raw must retain stderr");
  equal(result.output, "done", "parser must still receive the full stdout");
});

test("scheduler exit-drain flushes a trailing partial log line before the drain message", { timeout: 1000 }, async () => {
  const log = fakeLog();
  const partial = Buffer.from('{"type":"assistant","text":"tail café"}');
  const { io } = fakeIo((child) => {
    child.stdout.emit("data", Buffer.concat([thinking, partial]));
    child.emit("exit", 0);
  });
  const result = await held(runTask(task("log-drain", { timeoutMs: 500 }), "go", CFG,
    { ...io, exitDrainMs: 20 }, log, {}));
  ok(result.raw.includes(partial.toString("utf8")), "raw must retain the trailing partial stdout line");
  const bytes = log.bytes();
  const text = bytes.toString("utf8");
  ok(!text.includes("thinking_tokens"), "thinking event must remain filtered during drain");
  ok(text.includes(partial.toString("utf8")), "settle must flush the held partial line");
  ok(text.indexOf(partial.toString("utf8")) < text.indexOf("[swarm] exit drain fired"), "partial line must precede the drain message");
});