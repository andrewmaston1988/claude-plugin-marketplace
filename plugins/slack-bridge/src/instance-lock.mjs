// One bridge per stateDir: the lock is a listening named pipe (Windows) or unix
// socket (posix). The OS frees a pipe with its process; a posix socket file
// outlives a crash, so a stale one is reclaimed under an atomic mkdir guard.
import net from "node:net";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const PROBE_TIMEOUT_MS = 1000;
const RECLAIM_STALE_MS = 10_000;

export function lockPath(stateDir) {
  if (process.platform === "win32") {
    const hash = createHash("sha256").update(resolve(stateDir).toLowerCase(), "utf8").digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\claude-slack-${hash}`;
  }
  return join(stateDir, "claude-slack.sock");
}

// True when something answers on the lock. A timeout counts as alive: refusing
// a start is recoverable, two bridges are not.
export function probeInstance({ stateDir, _net = net }) {
  return new Promise((done) => {
    const sock = _net.connect(lockPath(stateDir));
    const finish = (alive) => { clearTimeout(timer); sock.destroy(); done(alive); };
    const timer = setTimeout(() => finish(true), PROBE_TIMEOUT_MS);
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
  });
}

function listen(_net, where) {
  return new Promise((ok, fail) => {
    const server = _net.createServer((s) => s.destroy());
    server.once("error", fail);
    server.listen(where, () => { server.off("error", fail); ok(server); });
  });
}

function held(server) {
  server.unref();
  return { release: () => new Promise((done) => server.close(() => done())) };
}

function alreadyRunning(where) {
  return Object.assign(new Error(`instance lock held: ${where}`), { code: "ALREADY_RUNNING" });
}

export async function acquireInstanceLock({ stateDir, _net = net }) {
  const where = lockPath(stateDir);
  if (process.platform !== "win32") mkdirSync(stateDir, { recursive: true });
  try {
    return held(await listen(_net, where));
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
  }
  if (process.platform === "win32" || await probeInstance({ stateDir, _net })) throw alreadyRunning(where);
  return reclaim({ stateDir, where, _net, retried: false });
}

async function reclaim({ stateDir, where, _net, retried }) {
  const guard = `${where}.reclaim`;
  try {
    mkdirSync(guard);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    // A guard left by a reclaimer that crashed mid-way would block every start.
    let age = 0;
    try { age = Date.now() - statSync(guard).mtimeMs; } catch {}
    if (retried || age <= RECLAIM_STALE_MS) throw alreadyRunning(where);
    rmSync(guard, { recursive: true, force: true });
    return reclaim({ stateDir, where, _net, retried: true });
  }
  try {
    // Another reclaimer may have won between our probe and the guard.
    if (await probeInstance({ stateDir, _net })) throw alreadyRunning(where);
    try { unlinkSync(where); } catch {}
    return held(await listen(_net, where));
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}
