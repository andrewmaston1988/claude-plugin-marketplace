// One engine owns a resultsDir. `refuseLiveEngine` infers that from the heartbeat,
// which is written late — after the estimate's corpus walk and `runPlan`'s startup —
// so a second `swarm run` started inside that window saw no heartbeat and proceeded:
// two engines resuming one Claude session, interleaved run.log writes.
//
// The claim is taken at the first point the run dir is known, and `wx` makes it one
// atomic step rather than a check followed by a write. `engine.lock` is separate from
// the heartbeat: the heartbeat is rewritten every tick and read by status/stop, and
// overloading it with claim semantics would couple two contracts.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { readHeartbeat } from "./results.mjs";

const REAL_FS = { mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync };

export function engineLockPath(dir) {
  return join(dir, "engine.lock");
}

// The same `<iso> <pid>` line the heartbeat carries, so the two files read alike.
export function readEngineLock(dir, _fs = REAL_FS) {
  let line;
  try { line = _fs.readFileSync(engineLockPath(dir), "utf8").trim(); } catch { return null; }
  const [iso, pidStr] = line.split(" ");
  return { iso, pid: Number.parseInt(pidStr, 10) || null };
}

// The daemon-lifecycle probe: kill(pid, 0) throws for a pid that is gone. A pid that
// cannot be parsed is treated as gone, which is the direction that clears a lock left
// by an owner that died between creating the file and writing the line.
export function engineAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Stale needs BOTH signals. The pid alone is wrong on Windows pid reuse — a live
// unrelated process holding the old pid reads alive, and refusing is the safe
// direction. The heartbeat alone is wrong during startup, where a fresh claim has no
// heartbeat yet. Requiring both refuses whenever in doubt.
function stale(dir, owner, heartbeatMs, isAlive) {
  if (owner.pid !== null && isAlive(owner.pid)) return false;
  const hb = readHeartbeat(dir);
  return !(hb && Date.now() - hb.mtimeMs < heartbeatMs * 3);
}

// { ok: true } when this process owns the dir; { ok: false, pid } when it does not —
// `pid` is the owner to name in the refusal (null if the lock was unreadable).
// Two attempts: the first loses to an existing lock, the second only runs after a
// stale one was cleared, so a racer that also judged it stale loses the retry.
export function claimEngine(dir, { heartbeatMs = 15_000, _fs = REAL_FS, _isAlive = engineAlive } = {}) {
  _fs.mkdirSync(dir, { recursive: true });
  const line = `${new Date().toISOString()} ${process.pid}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = _fs.openSync(engineLockPath(dir), "wx");
      try { _fs.writeSync(fd, line); } finally { _fs.closeSync(fd); }
      return { ok: true, pid: process.pid };
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
    }
    const owner = readEngineLock(dir, _fs);
    if (!owner || !stale(dir, owner, heartbeatMs, _isAlive)) {
      return { ok: false, pid: owner?.pid ?? null };
    }
    try { _fs.unlinkSync(engineLockPath(dir)); } catch { /* another racer cleared it first */ }
  }
  return { ok: false, pid: readEngineLock(dir, _fs)?.pid ?? null };
}

export function releaseEngine(dir, { _fs = REAL_FS } = {}) {
  try { _fs.unlinkSync(engineLockPath(dir)); } catch { /* never claimed, or already released */ }
}

// One wording for both verbs that take the claim, so `run` and `ask` cannot drift
// into telling the operator two different things about the same lock.
export function lockRefusal(dir, pid, verb) {
  return `swarm: ${dir} already has a live engine${pid ? ` (pid ${pid})` : ""} — swarm status ${dir} to watch it, swarm stop ${dir} to end it before ${verb}.`;
}
