import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  connectUnified, close,
  rowsList,
  progressDelete,
  projectHasActiveSession, sessionFinish,
  listEnabledProjects,
} from "../pipeline-db/index.mjs";
import { getPaths } from "../../src/paths.mjs";
import { publishNotification } from "../publisher.mjs";
import { resolveSessionFile } from "../session-gen.mjs";
import {
  readState, writeState, deleteState, pidAlive, startupGuard,
} from "./state-file.mjs";
import { spawnSession, spawnMerge } from "./spawn.mjs";
import { reapFinished } from "./reaper.mjs";
import { orchestratorWorktreePath } from "../worktree-paths.mjs";
import { spawnGovernor, spawnMonthlyGovernor } from "./governor.mjs";

// ── constants ─────────────────────────────────────────────────────────────────

const POLL_DEFAULT = 30;
const MAX_CONCURRENT_DEFAULT = 3;

// ── active-process map ────────────────────────────────────────────────────────

const activeProcs = new Map(); // Map<project, ChildProcess>

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

function depsMet(row, allRows, logFn) {
  const dependsOn = (row.depends_on || "").trim();
  if (!dependsOn) return true;
  const depSlugs = dependsOn.split(",").map(s => s.trim()).filter(Boolean);
  const doneFeatures = new Set(allRows.filter(r => r.stage === "done").map(r => r.feature));
  const unmet = depSlugs.filter(d => !doneFeatures.has(d));
  if (unmet.length) {
    const feature = row.feature || "?";
    logFn(`  [${feature}] deps not yet done: ${unmet.join(", ")} — holding`);
  }
  return unmet.length === 0;
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

  reapFinished(activeProcs, db, { logFn });

  const pipelinePaths = listEnabledProjects(db);
  let nProjects = 0, nQueued = 0, nActive = 0;

  for (const [project, projectRoot] of pipelinePaths) {
    if (projectFilter && project !== projectFilter) continue;
    nProjects++;

    let rows;
    try {
      rows = rowsList(db, project);
    } catch (e) {
      logFn(`[${project}] error reading pipeline: ${e.message}`, "ERROR");
      continue;
    }

    const allQueued  = rows.filter(r => r.stage === "queued");
    const queued     = allQueued.filter(r => depsMet(r, rows, logFn));
    nQueued         += allQueued.length;
    const nBlocked   = allQueued.length - queued.length;
    if (nBlocked) logFn(`[${project}] ${nBlocked} queued row(s) holding on unmet deps`);

    if (!queued.length) continue;

    if (activeProcs.has(project)) {
      logFn(`[${project}] session active (in-process) — skipping`);
      nActive++;
      continue;
    }

    if (projectIsActive(db, project)) {
      logFn(`[${project}] session active (DB) — skipping`);
      nActive++;
      continue;
    }

    if (activeProcs.size >= maxConcurrent) {
      logFn(`global cap ${maxConcurrent} reached — deferring [${project}]`);
      continue;
    }

    const row = queued[0];
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
    });

    if (!sessionFile) {
      logFn(`[${project}] no session file for '${row.feature}' — skipping`, "WARN");
      continue;
    }

    const proc = spawnSession(project, row, sessionFile, projectRoot, {
      db, dryRun, logFn,
    });
    if (proc !== null) {
      activeProcs.set(project, proc);
    }
  }

  // Second pass: stage=merge rows. One merge per project per tick.
  for (const [project, projectRoot] of pipelinePaths) {
    if (projectFilter && project !== projectFilter) continue;
    if (activeProcs.has(project)) continue;
    if (projectIsActive(db, project)) continue;
    if (activeProcs.size >= maxConcurrent) continue;

    const rows = rowsList(db, project);
    const mergeRow = rows.find(r =>
      r.stage === "merge" &&
      !r.rebase_required &&
      depsMet(r, rows, logFn)
    );
    if (!mergeRow) continue;

    const proc = spawnMerge(project, mergeRow, projectRoot, { db, dryRun, logFn });
    if (proc !== null) activeProcs.set(project, proc);
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
