// One engine owns a resultsDir. The claim is `wx`, so it is one atomic step rather than a
// check followed by a write, and it is taken at the first point the run dir is known — not
// when the heartbeat starts, which is after the estimate's corpus walk. `engine.lock` is
// separate from the heartbeat: the heartbeat is rewritten every tick and read by
// status/stop, and overloading it with claim semantics would couple two contracts.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { readHeartbeat } from "./results.mjs";

const REAL_FS = { mkdirSync, openSync, writeSync, closeSync, readFileSync, statSync, renameSync, unlinkSync };

export function engineLockPath(dir) {
  return join(dir, "engine.lock");
}

// The same `<iso> <pid>` line the heartbeat carries, so the two files read alike. `pid` is
// null for a lock that exists but carries no pid — the owner's create-to-write window — and
// then `mtimeMs` is the only age evidence the lock offers. `line`, `ino` and `mtimeMs`
// together identify the very file that was read, which is what lets a takeover prove it
// cleared the lock it judged rather than a racer's fresh one.
function readLockAt(p, _fs) {
  let line;
  try { line = _fs.readFileSync(p, "utf8").trim(); } catch { return null; }
  let mtimeMs = Date.now(), ino = null;
  try { const st = _fs.statSync(p); mtimeMs = st.mtimeMs; ino = st.ino ?? null; } catch { /* unreadable age reads as fresh: refusing is the safe direction */ }
  const [iso, pidStr] = line.split(" ");
  return { iso, pid: Number.parseInt(pidStr, 10) || null, mtimeMs, ino, line };
}

export function readEngineLock(dir, _fs = REAL_FS) {
  return readLockAt(engineLockPath(dir), _fs);
}

const sameLock = (a, b) => a !== null && b !== null && a.ino === b.ino && a.line === b.line && a.mtimeMs === b.mtimeMs;

// The daemon-lifecycle probe: kill(pid, 0) throws ESRCH for a pid whose process is gone, and
// EPERM for one that exists but cannot be signalled. A permission failure is not death, so
// only ESRCH — and a null pid — reads as gone; anything else stays alive.
export function engineAlive(pid, _kill = (p, sig) => process.kill(p, sig)) {
  if (pid === null || pid === undefined) return false;
  try { _kill(pid, 0); return true; } catch (e) { return e?.code !== "ESRCH"; }
}

// Stale needs BOTH signals. The pid alone is wrong on Windows pid reuse — a live
// unrelated process holding the old pid reads alive, and refusing is the safe
// direction. The heartbeat alone is wrong during startup, where a fresh claim has no
// heartbeat yet. Requiring both refuses whenever in doubt.
function stale(dir, owner, heartbeatMs, isAlive) {
  const bound = heartbeatMs * 3;
  // No pid to probe: the owner is between `wx` and its write, or crashed there. The lock's
  // own age is the only evidence, and a live owner's lock is seconds old.
  if (owner.pid === null) return Date.now() - owner.mtimeMs >= bound;
  if (isAlive(owner.pid)) return false;
  // Only the owner's own tick counts as evidence — the heartbeat on disk otherwise belongs
  // to a previous run that used this resultsDir.
  const hb = readHeartbeat(dir);
  return !(hb && hb.pid === owner.pid && Date.now() - hb.mtimeMs < bound);
}

// { ok: true } when this process owns the dir; { ok: false, pid } when it does not —
// `pid` is the owner to name in the refusal (null if the lock was unreadable).
export function claimEngine(dir, { heartbeatMs = 15_000, _fs = REAL_FS, _isAlive = engineAlive } = {}) {
  _fs.mkdirSync(dir, { recursive: true });
  const line = `${new Date().toISOString()} ${process.pid}\n`;
  for (let attempt = 0; attempt < 4; attempt++) {
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
    // The clear is a rename to a path only this process names, never a blind unlink: a racer
    // that judged the lock stale first takes the inode with it, and the loser's rename finds
    // ENOENT and re-judges from disk instead of deleting whatever is there.
    const stalePath = `${engineLockPath(dir)}.stale-${process.pid}`;
    try { _fs.renameSync(engineLockPath(dir), stalePath); } catch { continue; }
    // A racer that won the replacement race can have put a FRESH lock there by the time this
    // rename lands, and that one is not ours to clear. Prove the file we moved is the file we
    // judged; if it is not, put the owner's claim back untouched and refuse.
    const moved = readLockAt(stalePath, _fs);
    if (!sameLock(moved, owner)) {
      try { _fs.renameSync(stalePath, engineLockPath(dir)); } catch { /* the path was retaken; the refusal below still names the owner */ }
      return { ok: false, pid: moved?.pid ?? null };
    }
    try { _fs.unlinkSync(stalePath); } catch { /* already gone */ }
  }
  return { ok: false, pid: readEngineLock(dir, _fs)?.pid ?? null };
}

// Only the owner may release: a blind unlink would delete a claim a contender legitimately
// took over in the window between this engine's run ending and its process exiting.
export function releaseEngine(dir, pid, { _fs = REAL_FS } = {}) {
  if (readEngineLock(dir, _fs)?.pid !== pid) return;
  try { _fs.unlinkSync(engineLockPath(dir)); } catch { /* never claimed, or already released */ }
}

// One wording for both verbs that take the claim, so `run` and `ask` cannot drift
// into telling the operator two different things about the same lock. Carries no
// `swarm: ` prefix of its own — the CLI adds that, once, to whatever it prints.
export function lockRefusal(dir, pid, verb) {
  return `${dir} already has a live engine${pid ? ` (pid ${pid})` : ""} — swarm status ${dir} to watch it, swarm stop ${dir} to end it before ${verb}.`;
}
