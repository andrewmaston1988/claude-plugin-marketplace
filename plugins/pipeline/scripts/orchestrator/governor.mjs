// Governor: scheduled background reports session.
//
// Spawns a daily "full" report (00:01 UTC) and "status" reports at 06:01,
// 12:01, 18:01 UTC, plus a monthly report on the first of each month at
// 00:01 UTC. Catch-up logic re-spawns missed slots if reports are absent.
//
// **This is a carried-along feature** — see README "Governor and metrics" for
// the long-term plan to extract it into a separate plugin. Today the
// orchestrator wires the spawn loop here; gate with `cfg.governor.enabled`.
//
// All paths come from `cfg.governor.*` with the registered project's
// `root_path` as the fallback root. Operator opts in by setting
// `cfg.governor.enabled = true` and `cfg.governor.project = "<name>"`.
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  appendGovernorSpawn, lastGovernorSpawnTime, lastGovernorSpawnAny, appendSpawn,
  projectGetByName,
} from "../pipeline-db/index.mjs";
import { findClaude } from "./spawn.mjs";
import { loadPipelineConfig } from "../../src/pipeline-config.mjs";
import { getPaths } from "../../src/paths.mjs";
import { resolveTemplate } from "../worktree-paths.mjs";
import { updateSpend } from "../metrics/spend.mjs";

const _BUNDLED_GOVERNOR_TEMPLATE = fileURLToPath(
  new URL("../../templates/governor-session.md", import.meta.url)
);

// Resolve the governor execution context from config + registry. Returns null
// when disabled, misconfigured, or the named project isn't registered.
export function resolveGovernorContext(db, _cfg) {
  const cfg = _cfg ?? loadPipelineConfig();
  if (!cfg?.governor?.enabled) return null;
  const projectName = cfg.governor.project;
  if (!projectName) return null;
  const row = projectGetByName(db, projectName);
  if (!row?.root_path) return null;
  const projectRoot = row.root_path;
  const paths = getPaths();
  const projVars = { root: projectRoot, project: projectName };
  const _proj = (raw, fallback) => raw
    ? resolveTemplate(raw, projVars, { resolveBase: projectRoot, configDir: paths.configDir })
    : fallback;
  return {
    cfg,
    projectName,
    projectRoot,
    reportsDir:   _proj(cfg.governor.reports_dir, join(projectRoot, "reports")),
    sessionDir:   _proj(cfg.governor.session_dir, join(projectRoot, "sessions")),
    logDir:       _proj(cfg.governor.log_dir,     join(projectRoot, "logs")),
    templatePath: cfg.governor.template_path
      ? resolveTemplate(cfg.governor.template_path, projVars, {
          resolveBase: paths.configDir, configDir: paths.configDir,
        })
      : _BUNDLED_GOVERNOR_TEMPLATE,
    govModel:     cfg.models?.governor       || "claude-sonnet-4-6",
  };
}

// Report-presence check. slotHour 0 = daily "full" report; 6/12/18 = status.
function governorReportPresent(reportsDir, slotHour, reportDate) {
  if (slotHour === 0) {
    return existsSync(join(reportsDir, `governance-${reportDate}.md`));
  }
  const p = join(reportsDir, `status-${reportDate}.md`);
  if (!existsSync(p)) return false;
  const hour     = String(slotHour).padStart(2, "0");
  const slotFire = new Date(
    `${reportDate.slice(0, 4)}-${reportDate.slice(4, 6)}-${reportDate.slice(6, 8)}T${hour}:01:00Z`
  );
  try { return statSync(p).mtimeMs >= slotFire.getTime(); }
  catch { return false; }
}

function lastSpawnFor(db, slotHour) {
  try {
    const ts = lastGovernorSpawnTime(db, slotHour);
    return ts ? new Date(ts) : null;
  } catch { return null; }
}

// 5-minute global cooldown between any two governor spawns.
// Prevents cascading catch-up fires when the reports directory is empty
// (e.g. after a config change): each 30s orchestrator tick would otherwise
// spawn the next slot until all four are in flight simultaneously.
const GOVERNOR_COOLDOWN_MS = 5 * 60 * 1000;

// Decide whether to spawn the daily governor based on time-of-day, missing
// reports, and rate-limiting against the analytics table.
export function shouldSpawnGovernor(reportsDir, db, _now = new Date()) {
  const now      = _now;
  const todayStr  = now.toISOString().slice(0, 10).replace(/-/g, "");
  const yesterDt  = new Date(now); yesterDt.setUTCDate(now.getUTCDate() - 1);
  const yesterStr = yesterDt.toISOString().slice(0, 10).replace(/-/g, "");

  // Global cooldown: if any governor spawn happened recently, block all slots.
  try {
    const anyTs = lastGovernorSpawnAny(db);
    if (anyTs && (now.getTime() - new Date(anyTs).getTime()) < GOVERNOR_COOLDOWN_MS) {
      return { should: false, reportType: null, slotHour: null, skippedReason: "cooldown" };
    }
  } catch { /* non-fatal: proceed without cooldown check */ }

  // Catch-up: yesterday's full report missing.
  if (!governorReportPresent(reportsDir, 0, yesterStr)) {
    const last = lastSpawnFor(db, 0);
    if (!last || (now.getTime() - last.getTime()) > 3600000) {
      return { should: true, reportType: "full", slotHour: 0 };
    }
  }

  // Status catch-up: past slots today (most recent first).
  for (const slot of [18, 12, 6]) {
    if (now.getUTCHours() >= slot && !governorReportPresent(reportsDir, slot, todayStr)) {
      const last = lastSpawnFor(db, slot);
      if (!last || (now.getTime() - last.getTime()) > 3600000) {
        return { should: true, reportType: "status", slotHour: slot };
      }
    }
  }

  // Canonical window (HH:01-HH:59 UTC).
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  let reportType = null;
  let slotHour   = null;
  if (h === 0 && m >= 1)                      { reportType = "full";   slotHour = 0; }
  else if ([6, 12, 18].includes(h) && m >= 1) { reportType = "status"; slotHour = h; }

  if (!reportType) return { should: false, reportType: null, slotHour: null };

  const last = lastSpawnFor(db, slotHour);
  if (!last) return { should: true, reportType, slotHour };
  const lastDateStr = last.toISOString().slice(0, 10).replace(/-/g, "");
  if (lastDateStr === todayStr) return { should: false, reportType: null, slotHour: null };
  return { should: true, reportType, slotHour };
}

export function shouldSpawnMonthlyGovernor(db, _now = new Date()) {
  const now = _now;
  if (now.getUTCDate() !== 1 || now.getUTCHours() !== 0 || now.getUTCMinutes() < 1) return false;
  const last = lastSpawnFor(db, "monthly");
  if (!last) return true;
  return last.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10);
}

function expandTemplate(content, vars) {
  let out = content;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v == null ? "" : String(v));
  }
  return out;
}

async function _spawnGovernorImpl(db, { dryRun, logFn, ctx, reportType, slotHour, kind = "daily" }) {
  const now = new Date();
  const ts  = now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  const correlationId = kind === "monthly" ? `governor-monthly-${ts}` : `governor-${ts}`;

  const yest      = new Date(now); yest.setUTCDate(now.getUTCDate() - 1);
  const yesterStr = yest.toISOString().slice(0, 10).replace(/-/g, "");
  const todayStr  = now.toISOString().slice(0, 10).replace(/-/g, "");
  const reportDate = kind === "monthly"
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 86400000).toISOString().slice(0, 7).replace("-", "")
    : (reportType === "full" ? yesterStr : todayStr);

  if (dryRun) {
    logFn(`DRY-RUN: would spawn Governor session (${kind === "monthly" ? "monthly" : reportType} report)`);
    return false;
  }

  try {
    if (!existsSync(ctx.templatePath)) {
      logFn(`Governor template not found at ${ctx.templatePath} — skipping`, "WARN");
      return false;
    }
    const templateContent = readFileSync(ctx.templatePath, "utf8");

    mkdirSync(ctx.sessionDir, { recursive: true });
    const sessionName = kind === "monthly" ? `gov-monthly-${ts}.md` : `gov-${ts}.md`;
    const sessionPath = join(ctx.sessionDir, sessionName);

    mkdirSync(ctx.reportsDir, { recursive: true });

    const paths = getPaths();
    const expanded = expandTemplate(templateContent, {
      CORRELATION_ID: correlationId,
      PROJECT:        ctx.projectName,
      PROJECT_ROOT:   ctx.projectRoot,
      REPORTS_DIR:    ctx.reportsDir,
      REPORT_TYPE:    kind === "monthly" ? "monthly" : reportType,
      REPORT_DATE:    reportDate,
      CWD:            ctx.projectRoot,
      PIPELINE_DB:    join(paths.dataDir, "pipeline.db"),
    });
    writeFileSync(sessionPath, expanded, "utf8");

    try {
      appendGovernorSpawn(db, {
        slot_hour:   kind === "monthly" ? "monthly" : slotHour,
        spawn_time:  now.toISOString(),
        corr_id:     correlationId,
        report_type: kind === "monthly" ? "monthly" : reportType,
      });
    } catch (e) {
      logFn(`Warning: failed to record governor spawn: ${e.message}`, "WARN");
    }

    // Refresh spend data so the governor session reads fresh ccusage numbers.
    try {
      await updateSpend(db, reportDate);
    } catch (e) {
      logFn(`Warning: update-spend failed (non-fatal): ${e.message}`, "WARN");
    }

    const prompt = (
      `export CORRELATION_ID='${correlationId}' REPORT_TYPE='${kind === "monthly" ? "monthly" : reportType}'; ` +
      `Read '${sessionPath}' in full and execute the session.`
    );
    const claudePath = findClaude();
    const args = [
      "-p", prompt,
      "--model", ctx.govModel,
      "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep",
      "--max-budget-usd", "5.00",
    ];
    const env = { ...process.env };
    env.GIT_AUTHOR_NAME  = "Claude Agent";
    env.GIT_AUTHOR_EMAIL = `claude-agent@${correlationId}`;
    env.CORRELATION_ID   = correlationId;
    env.REPORT_TYPE      = kind === "monthly" ? "monthly" : reportType;

    mkdirSync(ctx.logDir, { recursive: true });
    const logPath = join(ctx.logDir, `gov-${correlationId}.log`);
    const fd = openSync(logPath, "a");
    const proc = spawn(claudePath, args, {
      cwd:         ctx.projectRoot,
      env,
      windowsHide: true,
      detached:    true,
      stdio:       ["ignore", fd, fd],
    });
    proc.unref();
    closeSync(fd);

    const spawnTime = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    try {
      appendSpawn(db, {
        spawn_time: spawnTime,
        corr_id:    correlationId,
        stype:      "governor",
        cwd:        ctx.projectRoot,
        project:    ctx.projectName,
        feature:    "governor",
      });
    } catch (e) {
      logFn(`Warning: failed to record spawn map: ${e.message}`, "WARN");
    }

    logFn(`Governor session spawned (corr_id=${correlationId}, kind=${kind}, report_date=${reportDate})`);
    return true;
  } catch (e) {
    logFn(`Governor spawn failed: ${e.message}`, "ERROR");
    return false;
  }
}

export async function spawnGovernor(db, { dryRun, logFn }) {
  const ctx = resolveGovernorContext(db);
  if (!ctx) return false;
  const { should, reportType, slotHour, skippedReason } = shouldSpawnGovernor(ctx.reportsDir, db);
  if (!should) {
    if (skippedReason === "cooldown") {
      logFn("Governor: spawn suppressed — another session launched within the last 5 minutes", "WARN");
    }
    return false;
  }
  return _spawnGovernorImpl(db, { dryRun, logFn, ctx, reportType, slotHour, kind: "daily" });
}

export async function spawnMonthlyGovernor(db, { dryRun, logFn }) {
  const ctx = resolveGovernorContext(db);
  if (!ctx) return false;
  if (!shouldSpawnMonthlyGovernor(db)) return false;
  return _spawnGovernorImpl(db, { dryRun, logFn, ctx, reportType: "monthly", slotHour: "monthly", kind: "monthly" });
}
