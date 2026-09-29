import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { tokenTotal } from "./stream.mjs";
import { inferStoredIdentity } from "./contracts.mjs";
import { listLeavesFrom } from "./leaf-list.mjs";
import { gradeFooter } from "./results-render.mjs";

// Results layout under <resultsDir>:
//   .gitignore          '*' — runs never pollute the repo
//   manifest.json       effective plan at dispatch (P1 — runs record their own intent):
//                       { goal?, ref?, args?, argsFingerprint?, resultsDir, tasks, digest? }
//                       (forEach/child expansion is runtime — reconstruct from run.log + per-leaf prompt)
//   results/<id>.json   { id, provider?, runner?, model, ok, exit, durationMs, tokens?, costUsd?, numTurns?, prompt?, output, outputJson?, rawOutput?, schemaRetried?, schemaErrors?, citations?, citationRefuted?, coverage?, worktree?, asks?, checkoutToplevel?, key? }
//                       (rawOutput = the leaf's own output on a schema failure — `output` then holds
//                        the validator's text; a re-run re-asks from it instead of redoing the work)
//                       (coverage = { status: "complete"|"incomplete"|"unparseable", required, read, missed[] }
//                        when the task declared mustRead — a shortfall is recorded, never fails the leaf)
//                       (asks = [{question, answer, ok, provider?, runner?, model, tokens?, sessionId?}] — `swarm ask` follow-ups;
//                        the leaf's own ok/output never change because a later ask failed)
//   results/<id>.ask.log  plain-text Q/A transcript, appended on every ask against this leaf
//                       (prompt = the exact final string sent to the leaf; absent on compute/aggregate rows; key = the task-definition hash resume reuses this result against — task-key.mjs)
//                       (citations = { checked, drifted, refuted } when N3 verified them; each cited finding is
//                        annotated citation:"verified"|"drift"|"refuted" in output. citationRefuted = [{path,reason}]
//                        for the kept-but-unverified findings — a citation never fails a leaf)
//   digest.md           when a digest block is present
//   summary.json        { started, finished, tasks, blocked, worktreesKept, totalTokens, estimate?, costWarnFired? }
//                       task rows: { id, provider?, runner?, model, state, durationMs, tokens, costUsd?, resultPath }
//                       (costUsd only for real-key-billed leaves — these rows ARE the estimate corpus)
//   run.log             JSONL, tailable mid-run:
//                         { ts, event: "run-start", tasks: [{ id, provider?, runner?, model }], ask? }   ask = the interrogated task id
//                         { ts, id, state, durationMs?, tokens?, note? }   state changes; a cache-miss { ts, id, event: "cache-miss", priorKey, reason } says resume re-ran a task whose definition changed
//                         { ts, id, event: "tokens", tokens }       live usage ticks
//                         { ts, id, event: "session", provider?, runner?, sessionId }   the leaf's session, as soon as its stream names it — resume reads it
//                         { ts, event: "expand", id, provider?, runner?, model, clones, truncated?, total? }   forEach expansion
//                         { ts, event: "expand-manifest", id, children: [{id, provider?, runner?, model}] }    child-manifest splice
//                       (child-manifest task ids are namespaced "<node>~<childId>")
//                         { ts, event: "truncate-prompt", id, depId, kept, total }   {{result:}} cut to the inline cap
//                         { ts, event: "leaf-contract-retry", id, attempt }   a corrective re-ask fired — schema/citation/coverage, or the 2nd/3rd schema-only turn
//                         { ts, event: "citations", id, checked, drifted, refuted }   N3 mechanical verification
//                         { ts, event: "coverage", id, status, required, read, missed, retried }   mustRead read-coverage check
//                         { ts, event: "cost-warn", unit, projected, threshold }   single-shot projection warn
//   grade-waiver.json   { waivedAt, reason } — written by `swarm grade --waive`; excuses the run from
//                       ungradedRuns/the grading nudges without ever counting as a grade

export function initResultsDir(dir) {
  mkdirSync(join(dir, "results"), { recursive: true });
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "*\n");
  return dir;
}

export function resultPath(dir, id) {
  return join(dir, "results", `${id}.json`);
}

// Re-exported from contracts.mjs, which owns identity, so the existing import sites
// do not all have to move.
export { inferStoredIdentity };

export function normalizeStoredIdentity(record) {
  if (!record || typeof record !== "object") return record;
  const inferred = inferStoredIdentity(record.modelAlias || record.model);
  const out = {
    ...record,
    ...(record.provider ? { provider: String(record.provider).toLowerCase() } : {}),
    ...(record.runner ? { runner: record.runner } : {}),
  };
  // Inferred fields are readable migration metadata, not a rewrite of the
  // legacy JSON shape. Keep them non-enumerable so byte-for-byte summary/result
  // carry-forward remains possible during ask/resume.
  if (!out.provider && inferred.provider) Object.defineProperty(out, "provider", { value: inferred.provider, enumerable: false });
  if (!out.runner && inferred.runner) Object.defineProperty(out, "runner", { value: inferred.runner, enumerable: false });
  return out;
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
    return normalizeStoredIdentity(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return null; // corrupt result — treat as absent so resume re-runs it
  }
}

// The leaf's raw stream-json events — the deeper read a grading agent reaches
// for when the result alone does not say whether the work was any good.
export function transcriptPath(dir, id) {
  return join(dir, "results", `${id}.log`);
}

// Manifest leaves with both paths; without a manifest, every result is included. `gradeable` is the
// grading store's scope: a gradeable leaf is one a real model ran (sentinel-model nodes produce no row).
export function listLeaves(dir, { gradeable = false } = {}) {
  return listLeavesFrom(dir, { gradeable }, { readResult, resultPath, transcriptPath });
}

// The mechanical block a score row copies — a projection of an existing result,
// never a re-read of the leaf. These columns make a grade auditable; they never
// replace one (numTurns cannot separate three turns doing the wrong thing from
// thirty being thorough).
export function mechanicalOf(result) {
  return {
    ok: result.ok ?? null,
    exit: result.exit ?? null,
    durationMs: result.durationMs ?? null,
    tokens: result.tokens ? tokenTotal(result.tokens) : null,
    costUsd: result.costUsd ?? null,
    numTurns: result.numTurns ?? null,
    schemaRetried: result.schemaRetried ?? false,
    citations: result.citations ?? null,
    coverage: result.coverage ?? null,
  };
}

export function writeManifestSnapshot(dir, doc) {
  const p = join(dir, "manifest.json");
  writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
  return p;
}

export function writeSummary(dir, obj) {
  const p = join(dir, "summary.json");
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  return p;
}

export function readSummary(dir, { normalize = true } = {}) {
  const p = join(dir, "summary.json");
  if (!existsSync(p)) return null;
  try {
    const summary = JSON.parse(readFileSync(p, "utf8"));
    if (!normalize) return summary;
    return {
      ...summary,
      ...(Array.isArray(summary.tasks) && { tasks: summary.tasks.map((task) => normalizeStoredIdentity(task)) }),
    };
  } catch {
    return null;
  }
}

export function writeDigestMd(dir, text, gradeable) {
  const p = join(dir, "digest.md");
  let out = text.endsWith("\n") ? text : text + "\n";
  if (gradeable?.count > 0) {
    out += "\n" + gradeFooter(gradeable) + "\n";
  }
  writeFileSync(p, out);
  return p;
}

export function appendRunLog(dir, obj) {
  appendFileSync(join(dir, "run.log"), JSON.stringify(obj) + "\n");
}

// id -> the last provider/session identity run.log recorded for it, across every generation.
export function recordedSessionRecords(dir) {
  const out = new Map();
  let text = "";
  try { text = readFileSync(join(dir, "run.log"), "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    if (!line.includes('"event":"session"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.id && typeof e.sessionId === "string") {
        const inferred = normalizeStoredIdentity({ model: e.model, provider: e.provider, runner: e.runner });
        out.set(e.id, {
          sessionId: e.sessionId,
          ...(e.provider ? { provider: e.provider } : inferred.provider ? { provider: inferred.provider } : {}),
          ...(e.runner ? { runner: e.runner } : inferred.runner ? { runner: inferred.runner } : {}),
        });
      }
    } catch { /* torn tail */ }
  }
  return out;
}

// Backward-compatible string map for callers that only need --resume.
export function recordedSessionIds(dir) {
  return new Map([...recordedSessionRecords(dir)].map(([id, value]) => [id, value.sessionId]));
}

// ── liveness control files ────────────────────────────────────────────────────
// heartbeat: one line, ISO timestamp + pid, overwritten whole on every tick — a
// torn write costs one tick, and the file's own mtime IS the liveness signal, so
// tmp+rename (which would also bump mtime, just later) buys nothing here.
// stop: presence alone is the signal — `swarm stop` creates it, the engine
// notices it on its next heartbeat tick. A fresh engine clears it on start
// (see runPlan) so a resumed run isn't stopped by its predecessor's marker.
export function heartbeatPath(dir) {
  return join(dir, "heartbeat");
}

export function stopPath(dir) {
  return join(dir, "stop");
}

export function waiverPath(dir) {
  return join(dir, "grade-waiver.json");
}

export function touchHeartbeat(dir, iso, pid) {
  writeFileSync(heartbeatPath(dir), `${iso} ${pid}\n`);
}

export function readHeartbeat(dir) {
  const p = heartbeatPath(dir);
  if (!existsSync(p)) return null;
  const line = readFileSync(p, "utf8").trim();
  const [, pidStr] = line.split(" ");
  return { mtimeMs: statSync(p).mtimeMs, pid: Number(pidStr) };
}

// Rendering lives in results-render.mjs (this module owns storage). Re-exported
// so every existing import site keeps naming results.mjs.
export {
  displayIdentity,
  formatClosing,
  formatKeptWorktrees,
  formatTokens,
  gradeFooter,
  renderProvenance,
  renderRoster,
  renderRun,
  renderStatus,
  truncationLines,
} from "./results-render.mjs";
