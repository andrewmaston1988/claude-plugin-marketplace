import { readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const STATE_FILE = join(homedir(), ".pipeline", "orchestrator.state.json");

export function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return null; }
}

// Atomic write — write to <STATE_FILE>.tmp then renameSync over the
// destination so a concurrent reader never sees a partial JSON payload
// (rename is atomic on Win/POSIX for same-volume targets).
export function writeState(status, { startedAt = null } = {}) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const state = readState() || {};
  state.status = status;
  state.last_poll = now;
  // Always re-stamp pid so the dashboard's liveness check works even when
  // the state file was wiped and re-created mid-run by a non-startedAt poll.
  state.pid = process.pid;
  if (startedAt) state.started_at = startedAt;
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, STATE_FILE);
  } catch {}
}

export function deleteState() {
  try { unlinkSync(STATE_FILE); } catch {}
}

export function pidAlive(pid) {
  // Defensive: reject non-numeric pid early so a corrupted state file can
  // never feed an untrusted value into process.kill or a shell command.
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch { return false; }
}

// Check for a running orchestrator and block or terminate it per --force flag.
// Exits the process when an active non-stale instance is found and --force is false.
export function startupGuard(force, logFn) {
  const state = readState();
  if (!state || state.status !== "running") return;
  const pid = state.pid;
  const lastPoll = state.last_poll || "";
  let stale = true;
  try {
    stale = (Date.now() - new Date(lastPoll).getTime()) > 120000;
  } catch {}

  if (!stale && pidAlive(pid)) {
    if (force) {
      logFn(`--force: terminating existing orchestrator (PID ${pid}, started ${state.started_at})`, "WARN");
      try { process.kill(pid); } catch {}
      // Give it 1s to clean up (synchronous sleep via Atomics).
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      } catch {}
    } else {
      process.stdout.write(
        `Orchestrator already running since ${state.started_at} (PID ${pid}, last poll ${lastPoll}). Use --force to override.\n`
      );
      process.exit(0);
    }
  } else {
    logFn(`Stale state file (PID ${pid} not alive or last_poll > 120s old) — proceeding`, "WARN");
  }
}
