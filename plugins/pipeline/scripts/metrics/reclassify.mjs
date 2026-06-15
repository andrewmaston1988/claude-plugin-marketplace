// Re-reads each session's JSONL first_prompt and re-applies the classifier
// to fix stale command_type / correlation_id in metric_sessions. Used after
// deploying classifier fixes to backfill historical rows.
//
// Ported from CLAUDE repo's cache_metrics.py::reclassify_historical (which
// read claude.db). After the pipeline absorb migration, metric_sessions and
// claude_sessions live in pipeline.db — this port targets the unified DB.
//
// The bridge_sessions fallback is intentionally omitted: the bridge_sessions
// table never existed in pipeline.db, and Slack-bridge sessions are correctly
// classified via user_type=external + absence from claude_sessions.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  classifyFirstPrompt,
  extractCommandTypeFromBranch,
  extractCommandTypeFromProject,
  loadInteractiveSessionIds,
  readSessionFull,
} from "./sessions.mjs";
import { loadSpawnMap } from "../pipeline-db/index.mjs";

/**
 * Re-classify every row in metric_sessions using current classifier logic.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ dryRun?: boolean, deps?: { readSessionFull?: Function, projectsDir?: string } }} [opts]
 */
export function reclassifyHistorical(db, opts = {}) {
  const { dryRun = false, deps = {} } = opts;
  const readFn  = deps.readSessionFull ?? readSessionFull;
  const projectsDir = deps.projectsDir ?? join(homedir(), ".claude", "projects");

  if (!existsSync(projectsDir)) {
    process.stdout.write("No ~/.claude/projects directory found.\n");
    return;
  }

  // session_id → jsonl path index
  const fileBySession = {};
  for (const pdirName of readdirSync(projectsDir, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name)) {
    const pdir = join(projectsDir, pdirName);
    try {
      for (const f of readdirSync(pdir).filter(f => f.endsWith(".jsonl"))) {
        fileBySession[f.replace(/\.jsonl$/, "")] = join(pdir, f);
      }
    } catch { /* skip unreadable dirs */ }
  }

  const spawnMap       = loadSpawnMap(db);
  const interactiveIds = loadInteractiveSessionIds(db);

  const rows = db.prepare(
    "SELECT id, session_id, command_type, correlation_id FROM metric_sessions"
  ).all();

  const changes = [];
  let noJsonl = 0;
  let noPrefix = 0;

  for (const row of rows) {
    const sid = row.session_id;
    if (!sid || !fileBySession[sid]) { noJsonl++; continue; }

    const data = readFn(fileBySession[sid]);
    if (!data) { noJsonl++; continue; }

    const [newType, newCorr] = classifyFirstPrompt(data.first_prompt ?? "", spawnMap);
    let commandType = newType;

    // Branch-prefix fallback (e.g. autonomous/... → dev)
    if (!commandType) {
      commandType = extractCommandTypeFromBranch(data.git_branch);
    }
    // Project-path fallback (worktree-derived) — only upgrade from "unknown"
    if (!commandType || commandType === "unknown") {
      const inferred = extractCommandTypeFromProject(data.cwd ?? "");
      if (inferred) commandType = inferred;
    }
    // Slack fallback: external user with no other classification
    if (data.user_type === "external" && ["unknown", null, undefined].includes(commandType)) {
      commandType = "slack";
    }
    // claude_sessions always wins (interactive sessions trump the prefix classifier)
    if (interactiveIds.has(sid)) commandType = "interactive";

    if (!commandType || commandType === "unknown") {
      noPrefix++;
      continue;
    }

    const oldType = row.command_type;
    const oldCorr = row.correlation_id;
    if (commandType !== oldType || (newCorr && newCorr !== oldCorr)) {
      changes.push({ id: row.id, sid, oldType, newType: commandType, oldCorr, newCorr });
    }
  }

  process.stdout.write(
    `scanned ${rows.length} rows; ${changes.length} would change; ` +
    `${noJsonl} have no JSONL; ${noPrefix} no prefix match\n`
  );

  if (dryRun) {
    const shift = {};
    for (const { oldType, newType } of changes) {
      const key = `${oldType ?? "(null)"} → ${newType}`;
      shift[key] = (shift[key] ?? 0) + 1;
    }
    for (const [k, v] of Object.entries(shift).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      process.stdout.write(`  ${k}: ${v}\n`);
    }
    return;
  }

  const stmt = db.prepare(
    "UPDATE metric_sessions SET command_type = ?, correlation_id = COALESCE(?, correlation_id) WHERE id = ?"
  );
  for (const { id, newType, newCorr } of changes) {
    stmt.run(newType, newCorr ?? null, id);
  }
  process.stdout.write(`updated ${changes.length} rows\n`);
}
