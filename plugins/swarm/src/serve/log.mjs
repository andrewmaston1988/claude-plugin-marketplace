// The daemon's structured log: line JSON, because a daemon with no console
// still has to be readable after the fact. Size-capped with ONE rotation — the
// dashboard is a convenience and its log must never grow unbounded on a machine
// nobody logs into. Never throws: a logging failure must not take the serve down.
import { appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";

export const LOG_MAX_BYTES = 1_000_000;

export function createLogger({ logDir, file = "dashboard.log", maxBytes = LOG_MAX_BYTES, now = Date.now } = {}) {
  if (!logDir) throw new Error("createLogger: logDir is required");
  const path = join(logDir, file);
  const log = (event, fields = {}) => {
    try {
      mkdirSync(logDir, { recursive: true });
      try { if (statSync(path).size > maxBytes) renameSync(path, `${path}.1`); } catch { /* absent file, or rotation impossible — append anyway */ }
      appendFileSync(path, JSON.stringify({ t: new Date(now()).toISOString(), event, ...fields }) + "\n", "utf8");
    } catch { /* logging must never take the daemon down */ }
  };
  return { log, path };
}