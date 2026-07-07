#!/usr/bin/env node
// Composable statusline segment: live progress of the most recent swarm run.
// Prints e.g. "🐝 5✓ 2▶ 1⧖" (ANSI-coloured — the statusline renders colour),
// or nothing when there is no recent run. Append to an existing statusLine
// command like the checkpoint plugin's cache-glyph.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const RECENT_MS = 30 * 60 * 1000; // ignore runs idle for >30 min

function swarmHome() {
  return process.env.SWARM_HOME || join(homedir(), ".swarm");
}

// Newest run.log under <home>/runs/<encoded-cwd>/<run>/ by mtime.
export function newestRunLog(home = swarmHome()) {
  const runsRoot = join(home, "runs");
  if (!existsSync(runsRoot)) return null;
  let best = null;
  for (const proj of readdirSync(runsRoot)) {
    const projDir = join(runsRoot, proj);
    let runs = [];
    try { runs = readdirSync(projDir); } catch { continue; }
    for (const run of runs) {
      const log = join(projDir, run, "run.log");
      try {
        const m = statSync(log).mtimeMs;
        if (!best || m > best.mtimeMs) best = { path: log, mtimeMs: m };
      } catch { /* not a run dir */ }
    }
  }
  return best;
}

export function glyphFromLog(content) {
  let tasks = [];
  const last = new Map();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.event === "run-start") { tasks = e.tasks || []; last.clear(); }
    else if (e.id) last.set(e.id, e.state);
  }
  const count = (s) => [...last.values()].filter((v) => v === s || (s === "failed" && v === "failed:timeout")).length;
  const running = count("running");
  const ok = count("ok") + count("skipped");
  const failed = count("failed") + count("blocked");
  const limited = count("rate-limited");
  const pending = tasks.filter((id) => !last.has(id)).length;
  const c = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
  const parts = [];
  if (ok) parts.push(c("32", `${ok}✓`));
  if (running) parts.push(c("36", `${running}▶`));
  if (limited) parts.push(c("33", `${limited}⧖`));
  if (failed) parts.push(c("31", `${failed}✗`));
  if (pending) parts.push(c("2", `${pending}·`));
  return parts.length ? `🐝 ${parts.join(" ")}` : "";
}

import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const best = newestRunLog();
    if (best && Date.now() - best.mtimeMs < RECENT_MS) {
      process.stdout.write(glyphFromLog(readFileSync(best.path, "utf8")));
    }
  } catch { /* statusline must never error */ }
  process.exit(0);
}
