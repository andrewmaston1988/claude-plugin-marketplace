// One place that owns the hub fixture's lifecycle, so every live task in the lane starts, reads
// and stops it the same way. The fixture itself (fixtures/hub_fixture.py) is what enforces the
// safe environment; this file only spawns it and waits.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BAKEOFF_DIR, HUB_ORIGIN, HUB_SCRATCH, sleep } from "./harness.mjs";

export const SESSION_FILE = join(HUB_SCRATCH, "session.json");
export const ACCESS_LOG = join(HUB_SCRATCH, "access.log");
export const DB_FILE = join(HUB_SCRATCH, "torrent-hub.db");

export async function hubAnswers() {
  try {
    const r = await fetch(`${HUB_ORIGIN}/health`, { signal: AbortSignal.timeout(400) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Spawn the fixture and wait until it is serving. Refuses to run over something already on the
 * port: a stale fixture from an earlier run would answer /health and quietly serve the wrong page.
 */
export async function startHubFixture({ tmdb = false, timeoutMs = 45000 } = {}) {
  if (await hubAnswers()) {
    throw new Error(`something is already answering on ${HUB_ORIGIN} — stop it first`);
  }
  const args = [join(BAKEOFF_DIR, "fixtures", "hub_fixture.py")];
  if (tmdb) args.push("--tmdb");
  const child = spawn("python", args, { cwd: BAKEOFF_DIR, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (b) => { log += b.toString(); });
  child.stderr.on("data", (b) => { log += b.toString(); });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hubAnswers()) {
      if (!existsSync(SESSION_FILE)) throw new Error(`no session file at ${SESSION_FILE}`);
      return {
        origin: HUB_ORIGIN,
        scratch: HUB_SCRATCH,
        cookie: JSON.parse(readFileSync(SESSION_FILE, "utf8")),
        log: () => log,
        stop() { try { child.kill(); } catch {} },
      };
    }
    await sleep(300);
  }
  try { child.kill(); } catch {}
  throw new Error(`the hub fixture never became healthy\n${log.slice(-2000)}`);
}

/** Access-log lines written after `offset` — the evidence a request did or did not leave. */
export function accessSince(offset) {
  const { size } = statSync(ACCESS_LOG);
  if (size <= offset) return { lines: [], offset: size };
  const fd = openSync(ACCESS_LOG, "r");
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  return { lines: buf.toString("utf8").split(/\r?\n/).filter(Boolean), offset: size };
}

export function accessLogSize() {
  try { return statSync(ACCESS_LOG).size; } catch { return 0; }
}

/** Rows in the scratch DB's feedback table — the write the guard is supposed to prevent. */
export function feedbackRows() {
  const db = new DatabaseSync(DB_FILE);
  try {
    return db.prepare("SELECT COUNT(*) AS c FROM rec_feedback").get().c;
  } finally {
    db.close();
  }
}

/** Remove one title's feedback rows, so repeated arms each start from a known-empty slate. */
export function clearFeedback(ck) {
  const db = new DatabaseSync(DB_FILE);
  try {
    db.prepare("DELETE FROM rec_feedback WHERE ck = ?").run(ck);
  } finally {
    db.close();
  }
}
