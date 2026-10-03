import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LEVELS = { info: 0, warn: 1, error: 2 };

// stderrOnly: for stdio servers, where stdout is the protocol pipe.
export function createLogger({ logDir, level = "info", tag = "bridge", stderrOnly = false }) {
  const threshold = LEVELS[level] ?? 0;
  let logFile = null;

  if (logDir) {
    try {
      mkdirSync(logDir, { recursive: true });
      logFile = `${logDir}/bridge.log`;
    } catch { /* non-fatal — logs to stdout only */ }
  }

  function write(lvl, msg, extra) {
    if (LEVELS[lvl] < threshold) return;
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      level: lvl,
      tag,
      msg,
      ...(extra && typeof extra === "object" ? extra : extra !== undefined ? { detail: extra } : {}),
    });
    if (stderrOnly) process.stderr.write(entry + "\n");
    else console[lvl === "error" ? "error" : lvl === "warn" ? "warn" : "log"](entry);
    if (logFile) {
      try { appendFileSync(logFile, entry + "\n"); } catch { /* non-fatal */ }
    }
  }

  const logger = {
    info: (msg, extra) => write("info", msg, extra),
    warn: (msg, extra) => write("warn", msg, extra),
    error: (msg, extra) => write("error", msg, extra),
    child: (childTag) => createLogger({ logDir, level, tag: `${tag}:${childTag}`, stderrOnly }),
  };

  return logger;
}
