import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { claimEngine, releaseEngine, readEngineLock, engineAlive, engineLockPath, lockRefusal } from "../src/engine-lock.mjs";
import { touchHeartbeat } from "../src/results.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "swarm-lock-"));
const DEAD_PID = 999_999;
const LIVE_PID = 4242;
// Two racers inside one test process: distinct pids on the lock line, so each reads
// the other as a live owner rather than as itself.
const RACER_A = 51_001;
const RACER_B = 51_002;

function writeLock(dir, pid) {
  writeFileSync(engineLockPath(dir), `${new Date().toISOString()} ${pid}\n`);
}

// A delegating `_fs` that stamps this racer's own pid into the lock line it writes, and
// runs `onClear` at its first clear attempt — the seam that makes the interleaving
// deterministic instead of timing-dependent.
function racingFs(pid, onClear) {
  return {
    mkdirSync: (...a) => nodeFs.mkdirSync(...a),
    openSync: (...a) => nodeFs.openSync(...a),
    closeSync: (fd) => nodeFs.closeSync(fd),
    readFileSync: (...a) => nodeFs.readFileSync(...a),
    statSync: (...a) => nodeFs.statSync(...a),
    writeSync: (fd, line) => nodeFs.writeSync(fd, String(line).replace(String(process.pid), String(pid))),
    renameSync: (...a) => { onClear(); return nodeFs.renameSync(...a); },
    unlinkSync: (p) => { onClear(); return nodeFs.unlinkSync(p); },
  };
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

// Both racers judge the same crashed lock stale — the ordinary case, since neither can
// see the other. A plain unlink cannot survive it: the loser's unlink deletes the
// winner's FRESHLY created lock, so both claim one resultsDir. Ordered deterministically
// through the `_fs` seam: the first racer's clear call runs the second racer to completion.
test("claim: two racers that both judge a crashed lock stale — exactly one claims it", () => {
  const dir = tmp();
  try {
    writeLock(dir, DEAD_PID);
    const isAlive = (pid) => pid === RACER_A || pid === RACER_B;
    let ran = false;
    let bResult;
    const bFs = racingFs(RACER_B, () => {});
    const aFs = racingFs(RACER_A, () => {
      if (ran) return;
      ran = true;
      bResult = claimEngine(dir, { _fs: bFs, _isAlive: isAlive, heartbeatMs: 50 });
    });
    const aResult = claimEngine(dir, { _fs: aFs, _isAlive: isAlive, heartbeatMs: 50 });
    ok(ran, "the interleaving did not fire — the seam no longer sees a clear attempt");
    equal([aResult, bResult].filter((r) => r.ok).length, 1,
      `both racers claimed one resultsDir: A=${JSON.stringify(aResult)} B=${JSON.stringify(bResult)}`);
    equal(readEngineLock(dir).pid, aResult.ok ? RACER_A : RACER_B, "the survivor's lock is the one on disk");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The owner sits in this state between `openSync(...,"wx")` and `writeSync` — a live
// engine with no pid on disk yet and no heartbeat either. Judging it by the pid alone
// reads "no owner" and steals it.
test("claim: a lock with no pid yet (owner between create and write) is refused", () => {
  const dir = tmp();
  try {
    writeFileSync(engineLockPath(dir), "");
    const r = claimEngine(dir, { heartbeatMs: 50 });
    equal(r.ok, false, "a live owner's half-written lock must not be stolen");
    equal(readFileSync(engineLockPath(dir), "utf8"), "", "the owner's lock is left alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The other half of that row: a crash between create and write leaves the same empty
// file behind forever, so refusing on emptiness alone would strand the resultsDir.
test("claim: an empty lock left by a crash is taken over once it is old enough", () => {
  const dir = tmp();
  try {
    const p = engineLockPath(dir);
    writeFileSync(p, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(p, old, old);
    const r = claimEngine(dir, { heartbeatMs: 50 });
    equal(r.ok, true, "a crash between create and write must self-heal, with no manual step");
    equal(readEngineLock(dir).pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The heartbeat is this process's tick, not a fact about the lock's owner. A resultsDir
// that already had a completed run carries the previous engine's recent heartbeat, which
// says nothing about the crashed owner recorded in the lock.
test("claim: a recent heartbeat from a different pid is not evidence the owner is alive", () => {
  const dir = tmp();
  try {
    writeLock(dir, DEAD_PID);
    touchHeartbeat(dir, new Date().toISOString(), LIVE_PID);
    const r = claimEngine(dir, { _isAlive: () => false, heartbeatMs: 5000 });
    equal(r.ok, true, "another run's heartbeat must not refuse the takeover");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release: only the recorded owner may clear the lock", () => {
  const dir = tmp();
  try {
    writeLock(dir, LIVE_PID);
    releaseEngine(dir, process.pid);
    equal(readEngineLock(dir)?.pid, LIVE_PID, "a non-owner's release must leave the lock alone");
    releaseEngine(dir, LIVE_PID);
    equal(existsSync(engineLockPath(dir)), false, "the owner's release removes it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release: removes the lock, and is a no-op when there is none", () => {
  const dir = tmp();
  try {
    claimEngine(dir);
    ok(existsSync(engineLockPath(dir)), "a claimed dir holds a lock");
    releaseEngine(dir, process.pid);
    equal(existsSync(engineLockPath(dir)), false);
    releaseEngine(dir, process.pid); // idempotent: a second release must not throw
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lockRefusal: carries no CLI prefix of its own, so the operator reads `swarm: ` once", () => {
  const msg = lockRefusal("/tmp/out", LIVE_PID, "asking");
  ok(!/^swarm: /.test(msg), `the CLI adds the prefix; the message must not carry it: ${msg}`);
  ok(/already has a live engine/.test(msg) && msg.includes(`pid ${LIVE_PID}`), msg);
});

test("engineAlive: ESRCH is gone, EPERM is alive — the process exists, we just may not signal it", () => {
  const esrch = () => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); };
  const eperm = () => { throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); };
  equal(engineAlive(1234, esrch), false);
  equal(engineAlive(1234, eperm), true, "taking over an unsignalable owner is the unsafe direction");
  equal(engineAlive(null, eperm), false, "no pid to probe is no owner");
});

test("engineAlive: the real probe reads a exited process as gone and this one as alive", () => {
  const child = spawnSync(process.execPath, ["-e", ""]);
  equal(engineAlive(child.pid), false, "a pid whose process has exited must read as dead");
  equal(engineAlive(process.pid), true);
});
