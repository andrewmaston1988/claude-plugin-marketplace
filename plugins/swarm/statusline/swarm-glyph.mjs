#!/usr/bin/env node
// Composable statusline segment: live progress of the most recent swarm run.
// Prints e.g. "🐝 5✓ 2▶ 1⧖" (ANSI-coloured — the statusline renders colour),
// or nothing when there is no recent run. Append to an existing statusLine
// command like the checkpoint plugin's cache-glyph.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tokenTotal } from "../src/stream.mjs";
import { formatTokens } from "../src/results.mjs";
import { readRunLog, listRuns } from "../src/runlog.mjs";

function swarmHome() {
  return process.env.SWARM_HOME || join(homedir(), ".swarm");
}

// Newest run.log under <home>/runs/<encoded-cwd>/<run>/ by mtime, whatever its
// liveness — the caller decides whether a finished/aborted run still prints.
export function newestRunLog(home = swarmHome()) {
  const [best] = listRuns(home);
  return best ? { path: join(best.dir, "run.log"), mtimeMs: best.mtimeMs, active: best.active } : null;
}

export function glyphFromLog(content) {
  const { tasks } = readRunLog(content);
  const count = (...states) => tasks.filter((t) => states.includes(t.state)).length;
  const running = count("running", "retrying");
  const ok = count("ok", "skipped");
  const failed = count("failed", "failed:timeout", "blocked");
  const limited = count("rate-limited");
  const quota = count("quota");
  const pending = count("pending");
  const c = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
  const parts = [];
  if (ok) parts.push(c("32", `${ok}✓`));
  if (running) parts.push(c("36", `${running}▶`));
  if (limited) parts.push(c("33", `${limited}⧖`));
  if (quota) parts.push(c("33", `${quota}⏳`));
  if (failed) parts.push(c("31", `${failed}✗`));
  if (pending) parts.push(c("2", `${pending}·`));
  const total = tasks.reduce((n, t) => n + (t.tokens ? tokenTotal(t.tokens) : 0), 0);
  if (total > 0) parts.push(c("2", formatTokens(total)));
  return parts.length ? `🐝 ${parts.join(" ")}` : "";
}

import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const best = newestRunLog();
    if (best && best.active) {
      process.stdout.write(glyphFromLog(readFileSync(best.path, "utf8")));
    }
  } catch { /* statusline must never error */ }
  process.exit(0);
}
