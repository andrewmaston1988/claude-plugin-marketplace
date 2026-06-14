import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import {
  connectUnified, close,
  rowsList, rowUpdate,
  progressDelete, progressListActive,
  projectHasActiveSession, sessionFinish, countActiveSessions, featureIsActive,
  listEnabledProjects,
} from "../pipeline-db/index.mjs";
import { getPaths } from "../../src/paths.mjs";
import { loadPipelineConfig } from "../../src/pipeline-config.mjs";
import { publishNotification, spawnMergeReadyHook, drainNotifications } from "../publisher.mjs";
import { resolveSessionFile } from "../session-gen.mjs";
import {
  readState, writeState, deleteState, pidAlive, startupGuard,
} from "./state-file.mjs";
import { spawnSession, spawnMerge, isDirtyTree, isMergedInto } from "./spawn.mjs";
import { detectDefaultBranch } from "../../src/cli/helpers.mjs";
import { reconcileSessions } from "./reaper.mjs";
import { depsMet } from "./deps.mjs";
import { orchestratorWorktreePath, resolveHookFirstToken } from "../worktree-paths.mjs";
import { fileURLToPath } from "node:url";
import { spawnGovernor, spawnMonthlyGovernor } from "./governor.mjs";

// ── constants ─────────────────────────────────────────────────────────────────

const POLL_DEFAULT = 30;
const MAX_CONCURRENT_DEFAULT = 3;

// Stages that can spawn a session directly, keyed from the stage column.
// queued is handled separately with notes-based type lookup (for backward compat).
const SPAWNABLE_STAGES = new Set(["queued", "research", "dev", "test", "review"]);

// Map from active stage to session type. queued is not here; it reads from notes.
const STAGE_SESSION_TYPE = {
  research: "research",
  dev:      "dev",
  test:     "test",
  review:   "review",
};

// Grace period (seconds) to skip respawning a row after the last spawn attempt.
// Gives the just-spawned session time to register in the sessions table.
const SPAWN_GRACE_PERIOD_SECONDS = 60;

// ── logger ────────────────────────────────────────────────────────────────────

function makeLogger(logFile) {
  return function log(msg, level = "INFO") {
    const entry = JSON.stringify({
      ts:    new Date().toISOString().slice(0, 19),
      level,
      msg,
    });
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      appendFileSync(logFile, entry + "\n", "utf8");
    } catch {}
  };
}

// ── notification helpers ──────────────────────────────────────────────────────

function notifyPollError(errorMsg) {
  const msg = `Orchestrator poll error (PID ${process.pid}):\n${errorMsg}`;
  publishNotification({ title: "Orchestrator Error", message: msg, priority: "high" }).catch(() => {});
}

// ── project active-session check ──────────────────────────────────────────────

function projectIsActive(db, project) {
  try {
    const active = projectHasActiveSession(db, project);
    if (!active) return false;
    const pid = active.pid;
    const isSession = "correlation_id" in active;
    const id = isSession ? active.correlation_id : active.slug;
    if (pid && pidAlive(pid)) return true;
    // Stale lock — mark inactive
    if (isSession) { try { sessionFinish(db, id); } catch {} }
    else           { try { progressDelete(db, id); } catch {} }
    return false;
  } catch { return false; }
}

// ── deps check ────────────────────────────────────────────────────────────────
// depsMet lives in ./deps.mjs (importable by tests without index.mjs's IIFE).

// ── merged-branch cleanup ─────────────────────────────────────────────────────

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Detect pipeline rows whose branch was merged outside the /merge skill and
// advance them to done. Only targets `merge`-stage rows to avoid touching
// in-flight dev/test/review work.
//
// Detection is hook-driven: cfg.hooks.merge_check is an executable invoked
// once per merge-stage row with the same env contract as the other merge
// hooks (PIPELINE_PROJECT / PIPELINE_FEATURE / PIPELINE_BRANCH /
// PIPELINE_TARGET_BRANCH / PIPELINE_PROJECT_ROOT / PLUGIN_DIR). Exit 0 means
// "this branch's PR is merged"; any other exit means not merged (or unknown).
// Platform-agnostic by design — a Bitbucket hook queries the PR API, a GitHub
// hook can shell out to `gh pr view`. No hook configured → no UI-merge
// detection; rows stay at stage=merge until /merge or `pipeline done`.
function cleanupMergedRows(db, project, projectRoot, { dryRun, logFn }) {
  let rows;
  try {
    rows = rowsList(db, project).filter(r => r.stage === "merge");
  } catch { return; }
  if (!rows.length) return;

  const cfg = loadPipelineConfig();
  const checkHook = resolveHookFirstToken(cfg.hooks?.merge_check, getPaths().configDir);
  if (!checkHook) return;

  const isMergedBranch = (row, branch, targetBranch) => {
    const argv = /\.(mjs|js)$/.test(checkHook) ? [process.execPath, [checkHook]] : [checkHook, []];
    const r = spawnSync(argv[0], argv[1], {
      timeout: 20000, windowsHide: true, stdio: "ignore",
      env: {
        ...process.env,
        PIPELINE_PROJECT:       project,
        PIPELINE_FEATURE:       row.feature,
        PIPELINE_BRANCH:        branch,
        PIPELINE_TARGET_BRANCH: targetBranch,
        PIPELINE_PROJECT_ROOT:  projectRoot,
        PLUGIN_DIR:             PLUGIN_DIR,
      },
    });
    return r.status === 0;
  };

  for (const row of rows) {
    // "—" is the row-add placeholder for "no branch recorded" — same sentinel
    // handling as the on_merge_ready firing below.
    const branch = (row.branch && row.branch !== "—") ? row.branch : `autonomous/${row.feature}`;
    const targetBranch = row.target_branch || detectDefaultBranch(projectRoot);
    if (!isMergedBranch(row, branch, targetBranch)) continue;

    logFn(`[${project}] '${row.feature}' branch merged on the remote — advancing to done`);
    if (dryRun) continue;

    try {
      rowUpdate(db, project, row.feature, { stage: "done" });
    } catch (e) {
      logFn(`[${project}] WARN: could not advance ${row.feature} to done: ${e.message}`, "WARN");
      continue;
    }

    // Clean up any lingering progress entries for this feature.
    const stem = row.feature;
    try {
      const entries = progressListActive(db, { project });
      for (const entry of entries) {
        if (entry.slug === stem || entry.slug.endsWith(`-${stem}`)) {
          try { progressDelete(db, entry.slug); } catch (e) { logFn(`[${project}] WARN: could not delete progress ${entry.slug}: ${e.message}`, "WARN"); }
        }
      }
    } catch {}
  }
}

// ── poll ──────────────────────────────────────────────────────────────────────

async function pollOnce({
  db, projectFilter, dryRun, maxConcurrent, logFn,
}) {
  // Governor checks (governor uses the unified DB; its project context is
  // read from config — see [[pipeline-plugin-strip-operator-private]] for the
  // governor config block. For now, governor runs with the DB handle.)
  spawnGovernor(db, { dryRun, logFn });
  spawnMonthlyGovernor(db, { dryRun, logFn });

  reconcileSessions(db, { logFn, dryRun });

  // Deliver notifications dropped when an agent's inline forwarder was killed on teardown.
  if (!dryRun) {
    try { await drainNotifications({ logFn }); }
    catch (e) { logFn(`notify-drain error: ${e.message}`, "WARN"); }
  }

  const cfg = loadPipelineConfig();
  const pipelinePaths = listEnabledProjects(db);
  let nProjects = 0, nQueued = 0, nActive = 0;

  // Load last-spawn-times from state for grace-period check.
  const state = readState() || {};
  const lastSpawnTimes = state.last_spawn_times || {};

  for (const [project, projectRoot] of pipelinePaths) {
    if (projectFilter && project !== projectFilter) continue;
    nProjects++;

    // Advance any merge-stage rows whose branch was squash-merged via GitHub.
    cleanupMergedRows(db, project, projectRoot, { dryRun, logFn });

    let rows;
    try {
      rows = rowsList(db, project);
    } catch (e) {
      logFn(`[${project}] error reading pipeline: ${e.message}`, "ERROR");
      continue;
    }

    const allQueued  = rows.filter(r => r.stage === "queued");
    const queued     = allQueued.filter(r => depsMet(r, rows, logFn, projectRoot, db));
    nQueued         += allQueued.length;
    const nBlocked   = allQueued.length - queued.length;
    if (nBlocked) logFn(`[${project}] ${nBlocked} queued row(s) holding on unmet deps`);

    // Collect all spawnable rows: queued (already filtered by deps) plus any
    // at an active stage (dev, test, research, review) that have no live session.
    const spawnableRows = [
      ...queued,
      ...rows.filter(r =>
        (r.stage === "dev" || r.stage === "test" || r.stage === "research" || r.stage === "review") &&
        depsMet(r, rows, logFn, projectRoot, db)
      ),
    ];

    if (!spawnableRows.length) continue;

    const scope = cfg.orch?.concurrency_scope || "feature";
    const blocked = scope === "project" ? projectIsActive(db, project) : false;
    if (blocked) {
      logFn(`[${project}] session active (scope=${scope}) — skipping`);
      nActive++;
      continue;
    }

    if (countActiveSessions(db) >= maxConcurrent) {
      logFn(`global cap ${maxConcurrent} reached — deferring [${project}]`);
      continue;
    }

    // Find the first row that meets spawn grace-period and retry-budget checks.
    const now = Date.now();
    let rowToSpawn = null;
    for (const row of spawnableRows) {
      if (scope === "feature" && featureIsActive(db, project, row.feature)) {
        logFn(`[${project}] '${row.feature}' already has active session — skipping row`);
        continue;
      }

      const key = `${project}:${row.feature}`;
      const lastSpawnTime = lastSpawnTimes[key] || 0;
      const ageSeconds = (now - lastSpawnTime) / 1000;

      // Grace-period check: skip if spawned within 60s.
      if (ageSeconds < SPAWN_GRACE_PERIOD_SECONDS) {
        logFn(`[${project}] '${row.feature}' in grace period (${Math.round(ageSeconds)}s < ${SPAWN_GRACE_PERIOD_SECONDS}s) — deferring`);
        continue;
      }

      // Retry-budget check: skip review-stage rows that have exhausted retries.
      if (row.stage === "review" && row.review_retries >= (row.review_retry_budget || 3)) {
        logFn(`[${project}] '${row.feature}' review retry budget exhausted (${row.review_retries}/${row.review_retry_budget}) — skipping`);
        continue;
      }

      rowToSpawn = row;
      break;
    }

    if (!rowToSpawn) continue;

    const row = rowToSpawn;
    const rowForSession = { ...row, notes: row.notes_extra || "", plan: row.plan_file || "" };
    // cwd = spawn worktree path. Same path the orchestrator hands to spawnSession
    // below, so the template's `{{CWD}}/reports/...` resolves to the actual
    // working dir the agent runs in.
    const planStem = (row.plan_file || "").replace(/\.md$/, "").split(/[\\/]/).pop();
    const cwdForSession = orchestratorWorktreePath({
      project, projectRoot, branch: `autonomous/${planStem}`,
    });
    const sessionFile = resolveSessionFile(rowForSession, project, {
      projectRoot,
      dry: dryRun,
      cwd: cwdForSession,
      stageSessionType: STAGE_SESSION_TYPE[row.stage], // Pass stage-mapped type
    });

    if (!sessionFile) {
      logFn(`[${project}] no session file for '${row.feature}' — skipping`, "WARN");
      continue;
    }

    spawnSession(project, row, sessionFile, projectRoot, {
      db, dryRun, logFn,
      stageSessionType: STAGE_SESSION_TYPE[row.stage], // Pass stage-mapped type
    });

    // Record spawn time for grace-period check on next poll.
    if (!dryRun) {
      lastSpawnTimes[`${project}:${row.feature}`] = now;
      writeState("running", { last_spawn_times: lastSpawnTimes });
    }
  }

  // Second pass: stage=merge rows. One merge per project per tick.
  for (const [project, projectRoot] of pipelinePaths) {
    if (projectFilter && project !== projectFilter) continue;

    const rows = rowsList(db, project);

    // Fire on_merge_ready for ALL unfired merge-stage rows — unconditional, does not
    // spawn a session so the concurrency guard must not block it.
    const unfired = rows.filter(r =>
      r.stage === "merge" &&
      depsMet(r, rows, logFn, projectRoot, db) &&
      !(r.notes_extra || "").includes("[merge-ready-fired]")
    );
    for (const row of unfired) {
      // "—" is the row-add placeholder for "no branch recorded" — treat it
      // like empty, same as spawn.mjs does, or the hook receives a literal
      // em-dash as PIPELINE_BRANCH and `git push origin —` fails.
      const rowBranch       = (row.branch && row.branch !== "—") ? row.branch : `autonomous/${row.feature}`;
      const rowTargetBranch = row.target_branch || detectDefaultBranch(projectRoot);
      spawnMergeReadyHook(project, row.feature, rowBranch, rowTargetBranch, projectRoot).catch(() => {});
      try {
        const n = row.notes_extra || "";
        rowUpdate(db, project, row.feature, { notes_extra: n ? `${n} [merge-ready-fired]` : "[merge-ready-fired]" });
      } catch {}
      logFn?.(`[${project}] on_merge_ready fired for '${row.feature}'`);
    }

    // Spawning a merge SESSION still needs the concurrency guards — one per project per tick.
    if (projectIsActive(db, project)) continue;
    if (countActiveSessions(db) >= maxConcurrent) continue;
    const mergeRow = rows.find(r =>
      r.stage === "merge" &&
      depsMet(r, rows, logFn, projectRoot, db)
    );
    if (!mergeRow) continue;

    const branch       = mergeRow.branch || `autonomous/${mergeRow.feature}`;
    const targetBranch = mergeRow.target_branch || detectDefaultBranch(projectRoot);

    if (!cfg.autoMerge) continue;
    if (activeProcs.has(project)) continue;
    if (projectIsActive(db, project)) continue;
    if (activeProcs.size >= maxConcurrent) continue;

    const diverged = !isMergedInto(targetBranch, branch, projectRoot);
    const dirty    = isDirtyTree(projectRoot);
    const model    = (diverged || dirty) ? "claude-sonnet-4-6" : "claude-haiku-4-5";
    spawnMerge(project, mergeRow, projectRoot, model, { db, dryRun, logFn });
  }

  return { nProjects, nQueued, nActive };
}

// ── main ──────────────────────────────────────────────────────────────────────

(async () => {
  const argv = process.argv.slice(2);
  function getFlag(name) {
    const i = argv.indexOf(name);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
  }
  const projectFilter  = getFlag("--project");
  const intervalSec    = parseInt(getFlag("--interval") || String(POLL_DEFAULT), 10) || POLL_DEFAULT;
  const maxConcurrent  = parseInt(getFlag("--max-concurrent") || String(MAX_CONCURRENT_DEFAULT), 10) || MAX_CONCURRENT_DEFAULT;
  const dryRun         = argv.includes("--dry-run");
  const force          = argv.includes("--force");
  const statusMode     = argv.includes("--status");
  const shutdownMode   = argv.includes("--shutdown");

  const paths = getPaths();
  const logFile = join(paths.logDir, "orchestrator.jsonl");
  const log = makeLogger(logFile);

  // ── --shutdown ──────────────────────────────────────────────────────────────
  if (shutdownMode) {
    const state = readState();
    if (!state || state.status !== "running") {
      process.stdout.write("not running — nothing to shut down\n");
      setTimeout(() => process.exit(0), 150);
      return;
    }
    const pid = state.pid;
    if (!pidAlive(pid)) {
      process.stdout.write(`PID ${pid} not alive — cleaning up stale state file\n`);
      deleteState();
      setTimeout(() => process.exit(0), 150);
      return;
    }
    process.stdout.write(`Sending SIGTERM to orchestrator (PID ${pid})...\n`);
    try { process.kill(pid); }
    catch (e) {
      process.stdout.write(`Failed to send SIGTERM to PID ${pid}: ${e.message}\n`);
      setTimeout(() => process.exit(1), 150);
      return;
    }
    let waited = 0;
    const check = () => {
      if (!pidAlive(pid)) {
        process.stdout.write(`Orchestrator (PID ${pid}) stopped cleanly\n`);
        setTimeout(() => process.exit(0), 150);
        return;
      }
      waited += 500;
      if (waited >= 5000) {
        process.stdout.write(`Orchestrator (PID ${pid}) did not exit within 5s — may need manual kill\n`);
        setTimeout(() => process.exit(1), 150);
        return;
      }
      setTimeout(check, 500);
    };
    check();
    return;
  }

  // ── --status ────────────────────────────────────────────────────────────────
  if (statusMode) {
    const state = readState();
    if (state && state.status === "running") {
      const pid       = state.pid;
      const lastPoll  = state.last_poll || "unknown";
      const startedAt = state.started_at || "unknown";
      let ageS = -1, stale = true;
      try {
        ageS  = Math.round((Date.now() - new Date(lastPoll).getTime()) / 1000);
        stale = ageS > 120;
      } catch {}
      if (!stale && pidAlive(pid)) {
        process.stdout.write(`running since ${startedAt} (PID ${pid}), last poll ${ageS}s ago\n`);
        setTimeout(() => process.exit(0), 150);
      } else {
        process.stdout.write(`not running (last seen ${lastPoll}, PID ${pid} — stale)\n`);
        setTimeout(() => process.exit(1), 150);
      }
    } else if (state && state.status === "stopped") {
      const stoppedAt = state.last_poll || "unknown";
      process.stdout.write(`not running (stopped cleanly at ${stoppedAt})\n`);
      setTimeout(() => process.exit(1), 150);
    } else {
      process.stdout.write("not running (no state file)\n");
      setTimeout(() => process.exit(1), 150);
    }
    return;
  }

  // ── startup ─────────────────────────────────────────────────────────────────
  startupGuard(force, log);

  let db;
  try {
    db = connectUnified(paths);
  } catch (e) {
    log(`Failed to open unified DB: ${e.message}`, "ERROR");
    process.stderr.write(`Failed to open unified DB: ${e.message}\n`);
    process.exit(1);
  }

  const cleanup = () => {
    log(`Orchestrator stopping (PID ${process.pid})`);
    try { close(db); } catch {}
    deleteState();
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT",  cleanup);
  process.on("exit",    () => {
    try { deleteState(); } catch {}
    try { close(db); } catch {}
  });

  const startedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  writeState("running", { startedAt });
  log(`Queue orchestrator starting (PID ${process.pid})`);
  if (dryRun)        log("Dry-run mode — no sessions will be spawned", "WARN");
  if (projectFilter) log(`Filtering to project: ${projectFilter}`);

  const intervalMs = intervalSec * 1000;

  async function runPoll() {
    writeState("running");
    try {
      const { nProjects, nQueued, nActive } = await pollOnce({
        db, projectFilter, dryRun, maxConcurrent, logFn: log,
      });

      const parts = [`polling… ${nProjects} project${nProjects !== 1 ? "s" : ""}`];
      if (nQueued) parts.push(`${nQueued} queued`);
      if (nActive) parts.push(`${nActive} active`);
      log(parts.join(", "));
    } catch (e) {
      log(`poll_once error: ${e.message}`, "ERROR");
      notifyPollError(e.message);
    }
    setTimeout(runPoll, intervalMs);
  }

  runPoll();
})().catch(e => {
  process.stderr.write(e.message + "\n");
  process.exit(1);
});
