// A session's claim on disk, and what its hooks need to reach the broker. Builtins
// only: the inbox hook loads this on every tool batch in every session.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

export function readSessionFile(stateDir, sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return null;
  const file = join(stateDir, "remote-sessions", `${sessionId}.json`);
  if (!existsSync(file)) return null;
  return { ...JSON.parse(readFileSync(file, "utf8")), seizeMark: statSync(file).mtimeMs };
}

export const brokerOptions = (session, config) => ({
  port: config.remote?.brokerPort ?? 7898,
  token: config.remote?.controlToken ?? null,
  configPath: session.configPath,
});
