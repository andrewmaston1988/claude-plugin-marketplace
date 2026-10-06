import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { claimEngine, releaseEngine, readEngineLock, engineAlive, engineLockPath } from "../src/engine-lock.mjs";
import { touchHeartbeat } from "../src/results.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "swarm-lock-"));
const DEAD_PID = 999_999;
const LIVE_PID = 4242;

function writeLock(dir, pid) {
  writeFileSync(engineLockPath(dir), `${new Date().toISOString()} ${pid}\n`);
}

// A heartbeat whose mtime is well outside `heartbeatMs * 3` — the staleness bound.
function writeStaleHeartbeat(dir, pid) {
  touchHeartbeat(dir, new Date().toISOString(), pid);
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(dir, "heartbeat"), old, old);
}

test("claim: a fresh claim on an empty dir wins and records this pid", () => {
  const dir = tmp();
  try {
    const r = claimEngine(dir);
    equal(r.ok, true);
    equal(r.pid, process.pid);
    equal(readEngineLock(dir).pid, process.pid, "the lock line must carry the owner pid, so a refusal can name it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim: a live owner is refused, and the refusal carries its pid", () => {
  const dir = tmp();
  try {
    writeLock(dir, LIVE_PID);
    const r = claimEngine(dir, { _isAlive: () => true, heartbeatMs: 50 });
    equal(r.ok, false);
    equal(r.pid, LIVE_PID);
    equal(readEngineLock(dir).pid, LIVE_PID, "a refused claim must leave the owner's lock alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim: a live owner is refused even when the heartbeat has gone stale", () => {
  const dir = tmp();
  try {
    writeLock(dir, LIVE_PID);
    writeStaleHeartbeat(dir, LIVE_PID);
    const r = claimEngine(dir, { _isAlive: () => true, heartbeatMs: 50 });
    equal(r.ok, false);
    equal(r.pid, LIVE_PID);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim: a dead owner with no heartbeat is taken over — a crash needs no manual cleanup", () => {
  const dir = tmp();
  try {
    writeLock(dir, DEAD_PID);
    const r = claimEngine(dir, { _isAlive: () => false, heartbeatMs: 50 });
    equal(r.ok, true);
    equal(readEngineLock(dir).pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim: a dead pid with a fresh heartbeat is refused", () => {
  const dir = tmp();
  try {
    writeLock(dir, DEAD_PID);
    touchHeartbeat(dir, new Date().toISOString(), DEAD_PID);
    const r = claimEngine(dir, { _isAlive: () => false, heartbeatMs: 5000 });
    equal(r.ok, false);
    equal(r.pid, DEAD_PID);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim: a dead pid whose heartbeat has gone stale is taken over too", () => {
  const dir = tmp();
  try {
    writeLock(dir, DEAD_PID);
    writeStaleHeartbeat(dir, DEAD_PID);
    const r = claimEngine(dir, { _isAlive: () => false, heartbeatMs: 50 });
    equal(r.ok, true);
    equal(readEngineLock(dir).pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim: an unreadable lock is refused rather than stolen", () => {
  const dir = tmp();
  try {
    const eexist = Object.assign(new Error("exists"), { code: "EEXIST" });
    const _fs = {
      mkdirSync() {},
      openSync() { throw eexist; },
      writeSync() {}, closeSync() {},
      readFileSync() { throw new Error("EIO"); },
      unlinkSync() { throw new Error("must not be reached"); },
    };
    const r = claimEngine(dir, { _fs });
    equal(r.ok, false);
    equal(r.pid, null, "nothing to name, so the refusal falls back to the generic wording");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release: removes the lock, and is a no-op when there is none", () => {
  const dir = tmp();
  try {
    claimEngine(dir);
    ok(existsSync(engineLockPath(dir)), "a claimed dir holds a lock");
    releaseEngine(dir);
    equal(existsSync(engineLockPath(dir)), false);
    releaseEngine(dir); // idempotent: a second release must not throw
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("engineAlive: the real probe reads a exited process as gone and this one as alive", () => {
  const child = spawnSync(process.execPath, ["-e", ""]);
  equal(engineAlive(child.pid), false, "a pid whose process has exited must read as dead");
  equal(engineAlive(process.pid), true);
});
