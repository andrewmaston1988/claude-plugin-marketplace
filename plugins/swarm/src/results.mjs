import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { bold, dim, green, red, cyan, magenta, yellow, paint } from "./ui.mjs";
import { tokenTotal } from "./stream.mjs";

// Results layout under <resultsDir>:
//   .gitignore          '*' — runs never pollute the repo
//   results/<id>.json   { id, model, ok, exit, durationMs, tokens?, costUsd?, numTurns?, output, outputJson?, schemaRetried?, schemaErrors?, worktree? }
//   digest.md           when a digest block is present
//   summary.json        { started, finished, tasks, blocked, worktreesKept, totalTokens }
//   run.log             JSONL, tailable mid-run:
//                         { ts, event: "run-start", tasks: [{ id, model }] }
//                         { ts, id, state, durationMs?, tokens?, note? }   state changes
//                         { ts, id, event: "tokens", tokens }       live usage ticks
//                         { ts, event: "expand", id, model, clones, truncated?, total? }   forEach expansion
//                         { ts, event: "schema-retry", id }         returns re-ask fired

export function initResultsDir(dir) {
  mkdirSync(join(dir, "results"), { recursive: true });
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "*\n");
  return dir;
}

export function resultPath(dir, id) {
  return join(dir, "results", `${id}.json`);
}

export function writeResult(dir, id, obj) {
  const p = resultPath(dir, id);
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  return p;
}

export function readResult(dir, id) {
  const p = resultPath(dir, id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null; // corrupt result — treat as absent so resume re-runs it
  }
}

export function writeSummary(dir, obj) {
  const p = join(dir, "summary.json");
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  return p;
}

export function writeDigestMd(dir, text) {
  const p = join(dir, "digest.md");
  writeFileSync(p, text.endsWith("\n") ? text : text + "\n");
  return p;
}

export function appendRunLog(dir, obj) {
  appendFileSync(join(dir, "run.log"), JSON.stringify(obj) + "\n");
}

// ── stdout contract ───────────────────────────────────────────────────────────
// The run repaints a full roster snapshot (header, one row per task, counts
// footer) on every state change and on a heartbeat, then a closing block:
// digest path, summary path, total tokens, kept worktrees. NEVER raw output.

const GLYPHS = {
  ok: "✓",
  failed: "✗",
  "failed:timeout": "✗",
  "rate-limited": "⧖",
  quota: "⏳",
  retrying: "↻",
  blocked: "⊘",
  skipped: "↷",
  running: "◐",
  pending: "·",
};

// States whose rows carry an explicit [state] tag; ok/running/pending read
// from the glyph alone.
const TAGGED = new Set(["failed", "failed:timeout", "rate-limited", "quota", "blocked", "skipped"]);

const FOOTER_ORDER = ["ok", "failed", "rate-limited", "quota", "blocked", "skipped", "running", "retrying", "pending"];

export function formatTokens(n) {
  if (!n) return "—";
  if (n < 1000) return String(n);
  const trim = (s) => s.replace(/\.0+$/, "");
  if (n < 1e6) return trim((n / 1000).toFixed(1)) + "k";
  return trim((n / 1e6).toFixed(2)) + "M";
}

const fmtSecs = (ms) => `${Math.max(0, Math.round(ms / 1000))}s`;

function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

// Full-run snapshot. tasks: [{ id, model, state, durationMs?, startedMs?,
// tokens?, activity?, lastEventMs? }] — durationMs for terminal states,
// startedMs for running (elapsed ticks against `now`), tokens in the
// src/stream.mjs shape. Running rows show their latest tool call; one that has
// been silent longer than quietWarnMs shows a staleness warning instead.
export function renderRoster({ title, tasks, now, startedMs, quietWarnMs }) {
  const norm = tasks.map((t) => ({ ...t, model: t.model || "?" }));
  const activityCell = (t) => {
    if (t.state === "retrying") return t.activity || ""; // the retry/fallback note
    if (t.state !== "running") return "";
    if (t.lastEventMs != null && quietWarnMs != null && now - t.lastEventMs > quietWarnMs) {
      return `⚠ quiet ${fmtSecs(now - t.lastEventMs)}`;
    }
    return t.activity || "";
  };
  const cells = norm.map((t) => ({
    glyph: GLYPHS[t.state] || "?",
    dur: t.state === "running" && t.startedMs != null ? fmtSecs(now - t.startedMs)
      : t.durationMs != null ? fmtSecs(t.durationMs) : "—",
    tok: formatTokens(tokenTotal(t.tokens)),
    tag: TAGGED.has(t.state) ? ` [${t.state}]` : "",
    act: activityCell(t),
  }));
  const width = (get, min) => Math.max(min, ...norm.map((t, i) => get(t, cells[i]).length));
  const idW = width((t) => t.id, 2);
  const modelW = width((t) => t.model, 2);
  const durW = width((_, c) => c.dur, 1);
  const tokW = width((_, c) => c.tok, 1);

  const lines = [`swarm · ${title} · ${norm.length} tasks · ${fmtElapsed(now - startedMs)}`, ""];
  norm.forEach((t, i) => {
    const c = cells[i];
    const act = c.act ? `  ${(c.act.startsWith("⚠") ? yellow : dim)(c.act)}` : "";
    lines.push(
      `  ${paint(t.state, c.glyph)}  ${bold(t.id.padEnd(idW))}  ${t.model.padEnd(modelW)}  ` +
      `${dim(c.dur.padStart(durW))}  ${c.tok.padStart(tokW)}${paint(t.state, c.tag)}${act}`
    );
  });

  const counts = {};
  for (const t of norm) {
    const key = t.state === "failed:timeout" ? "failed" : t.state;
    counts[key] = (counts[key] || 0) + 1;
  }
  const segments = FOOTER_ORDER.filter((k) => counts[k]).map((k) => paint(k, `${counts[k]} ${k}`));
  const total = norm.reduce((n, t) => n + tokenTotal(t.tokens), 0);
  if (total > 0) segments.push(bold(`${formatTokens(total)} tokens`));
  lines.push("", `  ${segments.join(dim(" · "))}`);
  return lines.join("\n");
}

// One-shot progress view for `swarm.mjs status <resultsDir>` — read-only,
// rebuilt from run.log so it matches the live snapshot exactly.
export function renderStatus(dir, now = Date.now(), quietWarnMs = 60000) {
  // Absolutise first: a relative resultsDir silently resolves against the
  // *viewer's* cwd (watch terminal), not the run's — the classic mismatch.
  dir = resolve(dir);
  const logPath = join(dir, "run.log");
  if (!existsSync(logPath)) {
    return `no run.log at ${logPath} (absolute) — either the run has not started or this is not the run's resultsDir; pass the absolute path printed at dispatch.`;
  }
  let roster = [];
  let startedMs = null;
  const state = new Map();
  const tokens = new Map();
  const durations = new Map();
  const runningSince = new Map();
  const activity = new Map();
  const lastEvent = new Map();
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // torn tail write mid-run
    }
    if (entry.event === "run-start") {
      // pre-token logs recorded plain id strings
      roster = (entry.tasks || []).map((t) => (typeof t === "string" ? { id: t, model: "?" } : t));
      startedMs = Date.parse(entry.ts) || now;
      state.clear(); tokens.clear(); durations.clear(); runningSince.clear();
      activity.clear(); lastEvent.clear();
      continue;
    }
    if (entry.event === "expand") {
      // forEach clones join the roster directly under their parent
      const rows = Array.from({ length: entry.clones || 0 }, (_, i) => ({ id: `${entry.id}[${i}]`, model: entry.model || "?" }));
      const idx = roster.findIndex((r) => r.id === entry.id);
      roster.splice(idx < 0 ? roster.length : idx + 1, 0, ...rows);
      continue;
    }
    if (!entry.id) continue;
    lastEvent.set(entry.id, Date.parse(entry.ts) || now);
    if (entry.event === "tokens") {
      tokens.set(entry.id, entry.tokens);
    } else if (entry.event === "activity") {
      activity.set(entry.id, entry.activity);
    } else if (entry.state) {
      state.set(entry.id, entry.state);
      if (entry.state === "running") runningSince.set(entry.id, Date.parse(entry.ts) || now);
      if (entry.durationMs != null) durations.set(entry.id, entry.durationMs);
      if (entry.tokens) tokens.set(entry.id, entry.tokens);
    }
  }
  const tasks = roster.map(({ id, model }) => ({
    id, model,
    state: state.get(id) || "pending",
    durationMs: durations.get(id),
    startedMs: runningSince.get(id),
    tokens: tokens.get(id),
    activity: activity.get(id),
    lastEventMs: lastEvent.get(id),
  }));
  const lines = [
    `${bold("run:")} ${cyan(dir)}`,
    "",
    renderRoster({ title: basename(dir), tasks, now, startedMs: startedMs ?? now, quietWarnMs }),
    "",
    `${bold("results:")} ${join(dir, "results")}`,
  ];
  if (existsSync(join(dir, "digest.md"))) lines.push(`${bold("digest:")} ${green(join(dir, "digest.md"))}`);
  if (existsSync(join(dir, "summary.json"))) lines.push(`${bold("summary:")} ${join(dir, "summary.json")}`);
  return lines.join("\n");
}

export function formatClosing({ digestPath, digestFailed, summaryPath, totalTokens, worktreesKept = [], truncations = [] }) {
  const lines = [];
  // loud by contract: a capped forEach must never read as full coverage
  for (const tr of truncations) {
    lines.push(`${yellow("⚠")} ${bold(tr.id)}: forEach ran the first ${tr.kept} of ${tr.total} items (maxItems cap) — raise maxItems and re-run to cover the rest`);
  }
  if (digestPath) lines.push(`${bold("digest:")} ${green(digestPath)}`);
  else if (digestFailed) lines.push(`${bold("digest:")} ${red("FAILED")} — read summary + per-task results instead`);
  else lines.push(dim("digest: none (no digest block in manifest)"));
  lines.push(`${bold("summary:")} ${summaryPath}`);
  if (totalTokens && tokenTotal(totalTokens) > 0) {
    const input = formatTokens(totalTokens.input + totalTokens.cacheCreation);
    lines.push(`${bold("tokens:")} ${formatTokens(tokenTotal(totalTokens))} (input ${input} · output ${formatTokens(totalTokens.output)})`);
  }
  if (worktreesKept.length) {
    lines.push(bold("worktrees kept:"));
    for (const wt of worktreesKept) {
      lines.push(`  ${bold(wt.id)}: ${magenta(wt.branch)} at ${wt.path}`);
    }
  }
  return lines.join("\n");
}
