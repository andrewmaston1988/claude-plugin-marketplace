// A session's claim on disk, and what its hooks need to reach the broker. Builtins
// only: the inbox hook loads this on every tool batch in every session.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

export function readSessionFile(stateDir, sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return null;
  const file = join(stateDir, "remote-sessions", `${sessionId}.json`);
  if (!existsSync(file)) return null;
  return { ...JSON.parse(readFileSync(file, "utf8")), seizeMark: statSync(file).mtimeMs };
}

// When the last Stop to send its turn-end started. The two Stop hooks run in
// parallel, and the waiter's read receipt must reach the daemon after the turn-end.
const turnEndFile = (stateDir, sessionId) => join(stateDir, "remote-sessions", `${sessionId}.turn-end`);

// In place, not tmp + rename: the waiter polls it, and on Windows a rename over a
// file being read throws EPERM. A torn read parses as 0, which reads as "not yet".
export function writeTurnEnd(stateDir, sessionId, stopStartedAt) {
  try {
    writeFileSync(turnEndFile(stateDir, sessionId), String(stopStartedAt));
  } catch {
    // The waiter's hold is bounded: a lost marker costs seconds, not the message.
  }
}

export function readTurnEnd(stateDir, sessionId) {
  try {
    return Number(readFileSync(turnEndFile(stateDir, sessionId), "utf8")) || 0;
  } catch {
    return 0;
  }
}

export const brokerOptions =(session, config) => ({
  port: config.remote?.brokerPort ?? 7898,
  token: config.remote?.controlToken ?? null,
  configPath: session.configPath,
});
