#!/usr/bin/env node
// Claude Code statusline: the live swarm fleet, read from run dirs on disk.
//
// The harness renders whatever this prints as its status bar. Zero model cost:
// file stats only. A run is LIVE when it has no summary.json / digest.md and its
// run.log moved within the freshness window; a leaf is done when
// results/<id>.json exists, running when only <id>.log does.
//
// Only runs THIS session launched are shown: the engine stamps the launching
// CLAUDE_CODE_SESSION_ID as `launcher` on its run-start event, matched against
// the session_id the harness pipes on stdin. Runs predating the stamp fall back
// to a cwd match. No stdin (manual run) shows every live run.
//
// Wired via settings.json through the self-resolving shim `swarm statusline
// install` writes — never at this file's plugin-cache path, which changes on
// every plugin update.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tokenTotal } from "../src/stream.mjs";
import { formatTokens } from "../src/results.mjs";

const FRESH_MS = 6 * 3600 * 1000;   // a run.log older than this is abandoned, not live
const QUIET_FLAG_MS = 5 * 60 * 1000; // flag leaves silent longer than this

// One pass over run.log: work-token total (same arithmetic as `swarm status`:
// cache reads excluded, latest event per leaf wins) plus the launcher stamp.
function runMeta(logPath) {
  const latest = new Map();
  let launcher = null;
  try {
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      const isTok = line.includes('"tokens"'), isStart = line.includes('"run-start"');
      if (!isTok && !isStart) continue;
      try {
        const e = JSON.parse(line);
        if (isTok && e.id && e.tokens) latest.set(e.id, e.tokens);
        if (isStart && e.event === "run-start") launcher = e.launcher ?? null;
      } catch { /* partial line */ }
    }
  } catch { /* unreadable */ }
  let tokens = 0;
  for (const t of latest.values()) tokens += tokenTotal(t);
  return { tokens, launcher };
}

// The harness pipes session JSON on stdin; a TTY means a manual run, no filter.
function sessionInfo() {
  if (process.stdin.isTTY) return {};
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return {}; }
}
const encodeCwd = (p) => String(p).replace(/[\\/:]/g, "-"); // same rule as the runs dir

const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return null; } };
const listDir = (p) => { try { return readdirSync(p); } catch { return []; } };

export function liveRuns({ home = join(homedir(), ".swarm"), now = Date.now(), session = sessionInfo() } = {}) {
  const runsRoot = join(home, "runs");
  const out = [];
  if (!existsSync(runsRoot)) return out;
  const sid = session.session_id || null;
  const cwdEnc = encodeCwd(session.workspace?.current_dir ?? session.cwd ?? "");
  const mine = (cwdDir, launcher) => !sid || launcher === sid || (launcher === null && cwdDir === cwdEnc);
  for (const cwdDir of listDir(runsRoot)) {
    for (const run of listDir(join(runsRoot, cwdDir))) {
      const rd = join(runsRoot, cwdDir, run);
      const logM = mtime(join(rd, "run.log"));
      // summary.json marks the run finished by any route — digested, failed at
      // setup, blocked — so a corpse with a fresh run.log is not live.
      if (existsSync(join(rd, "summary.json")) || existsSync(join(rd, "digest.md")) || logM === null) continue;
      if (now - logM > FRESH_MS) continue;
      let total = 0;
      const model = new Map();
      try {
        const tasks = JSON.parse(readFileSync(join(rd, "manifest.json"), "utf8")).tasks;
        total = tasks.length;
        for (const t of tasks) model.set(t.id, String(t.model || "").replace(/:cloud$/, ""));
      } catch { /* no manifest yet */ }
      const res = join(rd, "results");
      let ok = 0, failed = 0, quiet = 0;
      const running = [];
      for (const f of listDir(res)) {
        if (f.startsWith("__")) continue;
        if (f.endsWith(".json")) {
          // a result file is written for failures too; only ok:true counts
          let r = null;
          try { r = JSON.parse(readFileSync(join(res, f), "utf8")); } catch { /* mid-write */ }
          if (r && r.ok === false) failed++; else ok++;
        } else if (f.endsWith(".log")) {
          const leaf = f.slice(0, -4);
          if (!existsSync(join(res, leaf + ".json"))) {
            running.push(leaf);
            quiet = Math.max(quiet, now - (mtime(join(res, f)) ?? now));
          }
        }
      }
      const { tokens, launcher } = runMeta(join(rd, "run.log"));
      out.push({ run, ok, failed, total, running, quiet, model, tokens, mine: mine(cwdDir, launcher) });
    }
  }
  return out;
}

export function render(opts = {}) {
  // ANSI: the harness passes escape codes through to the bar.
  const G = "\x1b[32m", Y = "\x1b[33m", D = "\x1b[2m", X = "\x1b[0m";
  const runs = liveRuns(opts).filter((r) => r.mine);
  if (!runs.length) return ""; // nothing of ours: blank bar, not "idle"
  // Font-independent "negative circle": truecolour light-blue background with
  // black text — the circled-digit glyphs render wide (emoji fallback) in some
  // fonts, and the palette's bright cyan is too dull.
  const INV = "\x1b[48;2;0;204;204;30m";
  const BLUE = "\x1b[38;2;0;204;204m";
  const parts = [];
  let stalest = null;
  runs.sort((a, b) => (a.run < b.run ? -1 : a.run > b.run ? 1 : 0));
  for (const { run, ok, failed, total, running, quiet, model, tokens } of runs) {
    const short = run.replaceAll("scenario-", "").replaceAll("-impl-1", "").replaceAll("-1", "");
    // ✓ all leaves done (green), ◐ a leaf is live, ○ nothing running, not done
    const [sym, col] = ok === total ? ["✓", G] : running.length ? ["◐", BLUE] : ["○", BLUE];
    // the models seated on the live leaves, deduped
    const agents = [...new Set(running.map((id) => model.get(id)).filter(Boolean))].join(",");
    const tail = [agents, formatTokens(tokens)].filter(Boolean).join(" ");
    parts.push(`${short} ${col}${ok}/${total} ${sym}${X}` + (failed ? ` ${Y}✗${failed}${X}` : "") + (tail ? ` ${D}${tail}${X}` : ""));
    if (quiet > QUIET_FLAG_MS && (stalest === null || quiet > stalest.quiet)) {
      stalest = { label: `${short} ${running.join("/") || "?"}`, quiet };
    }
  }
  const sep = `${D} · ${X}`;
  let line = `${BLUE}swarm${X} ${INV} ${runs.length} ${X}` + sep + parts.join(sep);
  // stale is yellow, not red: a quiet leaf is usually slow, not failed
  if (stalest) line += sep + `${Y}⚠ ${stalest.label} quiet ${Math.floor(stalest.quiet / 60000)}m${X}`;
  return line;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  let line = "";
  try { line = render({ home: process.env.SWARM_HOME || join(homedir(), ".swarm") }); } catch { /* statusline must never error */ }
  process.stdout.write(line + "\n");
}
