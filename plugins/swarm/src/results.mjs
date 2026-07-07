import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// Results layout under <resultsDir>:
//   .gitignore          '*' — runs never pollute the repo
//   results/<id>.json   { id, model, ok, exit, durationMs, output, outputJson?, worktree? }
//   digest.md           when a digest block is present
//   summary.json        { started, finished, tasks, blocked, worktreesKept }
//   run.log             one JSONL line per task state-change (tailable mid-run)

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
// One status line per task as it completes, then a closing block: digest path
// (or "no digest"), summary path, kept-worktree list. NEVER raw task output.

const GLYPHS = {
  ok: "✓",             // ✓
  failed: "✗",         // ✗
  "failed:timeout": "✗",
  "rate-limited": "⧖", // ⧖
  blocked: "⊘",        // ⊘
  skipped: "↷",        // ↷
};

export function formatStatusLine({ id, model, state, durationMs }) {
  const glyph = GLYPHS[state] || "?";
  const dur = durationMs != null ? ` ${Math.round(durationMs / 1000)}s` : "";
  const suffix = state === "ok" ? "" : ` [${state}]`;
  return `${glyph} ${id} ${model}${dur}${suffix}`;
}

// One-shot progress view for `swarm.mjs status <resultsDir>` — read-only,
// derived from run.log (JSONL state changes). The latest run-start line names
// every task, so ids never seen since it are pending.
export function renderStatus(dir, now = Date.now()) {
  // Absolutise first: a relative resultsDir silently resolves against the
  // *viewer's* cwd (watch terminal), not the run's — the classic mismatch.
  dir = resolve(dir);
  const logPath = join(dir, "run.log");
  if (!existsSync(logPath)) {
    return `no run.log at ${logPath} (absolute) — either the run has not started or this is not the run's resultsDir; pass the absolute path printed at dispatch.`;
  }
  let allTasks = [];
  const last = new Map(); // id -> { state, ts }
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // torn tail write mid-run
    }
    if (entry.event === "run-start") {
      allTasks = entry.tasks || [];
      last.clear();
    } else if (entry.id) {
      last.set(entry.id, { state: entry.state, ts: entry.ts });
    }
  }
  const counts = { ok: 0, running: 0, failed: 0, "rate-limited": 0, blocked: 0, skipped: 0, pending: 0 };
  for (const { state } of last.values()) {
    const key = state === "failed:timeout" ? "failed" : state;
    counts[key] = (counts[key] || 0) + 1;
  }
  counts.pending = allTasks.filter((id) => !last.has(id)).length;

  const lines = [`run: ${dir}`];
  lines.push(
    ["ok", "running", "failed", "rate-limited", "blocked", "skipped", "pending"]
      .map((k) => `${k} ${counts[k]}`)
      .join(" | ")
  );
  const running = [...last.entries()].filter(([, v]) => v.state === "running");
  if (running.length) {
    lines.push("running:");
    for (const [id, v] of running) {
      const elapsed = Math.max(0, Math.round((now - Date.parse(v.ts)) / 1000));
      lines.push(`  ${id} — ${elapsed}s elapsed`);
    }
  }
  lines.push(`results: ${join(dir, "results")}`);
  if (existsSync(join(dir, "digest.md"))) lines.push(`digest: ${join(dir, "digest.md")}`);
  if (existsSync(join(dir, "summary.json"))) lines.push(`summary: ${join(dir, "summary.json")}`);
  return lines.join("\n");
}

export function formatClosing({ digestPath, digestFailed, summaryPath, worktreesKept = [] }) {
  const lines = [];
  if (digestPath) lines.push(`digest: ${digestPath}`);
  else if (digestFailed) lines.push(`digest: FAILED — read summary + per-task results instead`);
  else lines.push("digest: none (no digest block in manifest)");
  lines.push(`summary: ${summaryPath}`);
  if (worktreesKept.length) {
    lines.push("worktrees kept:");
    for (const wt of worktreesKept) {
      lines.push(`  ${wt.id}: ${wt.branch} at ${wt.path}`);
    }
  }
  return lines.join("\n");
}
