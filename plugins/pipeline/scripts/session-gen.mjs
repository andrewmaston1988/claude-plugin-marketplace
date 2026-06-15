import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipelineConfig } from "../src/pipeline-config.mjs";
import { reportPath, featureWorktreePath, resolveTemplate, resolveRowBranch } from "./worktree-paths.mjs";
import { getPaths } from "../src/paths.mjs";
import { resolvePlanFile } from "../src/plans-resolver.mjs";

function _todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function _sessionTypeFromNotes(notes) {
  const m = notes.match(/\btype=(dev|research|test|review)\b/);
  return m ? m[1] : "dev";
}

// Plugin-bundled templates live next to this script under ../templates/.
const _BUNDLED_TEMPLATES_DIR = fileURLToPath(new URL("../templates", import.meta.url));

// Absolute path to the plugin's CLI entry. Substituted into templates as
// `{{PIPELINE_BIN}}` so spawned `claude -p` sessions can invoke it directly,
// without relying on a PATH alias (which lives in the user's shell profile
// and is unavailable in the spawned env).
// Absolute paths to BOTH node and the plugin's pipeline.mjs. The bare `node`
// binary is on PATH for the operator's shell (Bash) but NOT for the PowerShell
// the autonomous claude session uses — agents have been failing to call
// pipeline subcommands because PowerShell couldn't resolve `node`. Using the
// orchestrator's own `process.execPath` guarantees the same node runtime is
// used downstream and works in both shells.
const _PIPELINE_BIN = `"${process.execPath}" "${fileURLToPath(new URL("../bin/pipeline.mjs", import.meta.url))}"`;

// Resolve the template file for a session type. Honours
// `cfg.session_templates_dir` override with per-file fallback to bundled —
// so an operator can override just the templates they care about.
function _resolveTemplatePath(sessionType, _cfg = loadPipelineConfig()) {
  return _resolvePartialPath(`${sessionType}-session.md`, _cfg);
}

// Same override-then-bundled resolution as _resolveTemplatePath but for any
// named partial in the templates dir (e.g. shared progress-tracking block).
function _resolvePartialPath(name, _cfg = loadPipelineConfig()) {
  const override = _cfg.session_templates_dir;
  if (override) {
    const paths = getPaths();
    const resolvedDir = resolveTemplate(override, {}, {
      resolveBase: paths.configDir,
      configDir: paths.configDir,
    });
    const candidate = join(resolvedDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return join(_BUNDLED_TEMPLATES_DIR, name);
}

// Substitute {{PLACEHOLDER}} tokens. Unknown placeholders are left untouched
// so the caller can see what was missed; nullish values render as "".
function _expand(content, vars) {
  let out = content;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v == null ? "" : String(v));
  }
  return out;
}

// Find the most recent test report for a feature.
function _findMostRecentTestReport(feature, testReportsDir) {
  if (!testReportsDir || !existsSync(testReportsDir)) return null;
  try {
    const files = readdirSync(testReportsDir);
    const reports = files
      .filter(f => f.startsWith(`test-report-`) && f.includes(`-${feature}-`) && f.endsWith(".md"))
      .sort()
      .reverse();
    if (reports.length > 0) {
      return join(testReportsDir, reports[0]);
    }
  } catch (e) {
    // silently ignore errors reading the directory
  }
  return null;
}

// Generate a session file from a plugin-owned template + plan.
//
// projectRoot is required; everything else is optional with sensible defaults.
// Sessions are written under <projectRoot>/sessions/<type>-<date>-<stem>.md.
export function generateSessionFile(
  project,
  planFile,
  sessionType,
  {
    projectRoot,
    feature,
    targetBranch = "main",
    branch,
    cwd,
    reviewSkill,
    reviewRetries = 0,
    devRetries = 0,
    devRetryBudget = 2,
    _cfg,
  } = {}
) {
  if (!projectRoot) throw new Error("generateSessionFile: projectRoot is required");

  if (!planFile.endsWith(".md")) planFile += ".md";
  const planStem = basename(planFile, ".md");
  if (!feature) feature = planStem;
  // Session slug, branch, and worktree all derive from `feature` -- the
  // canonical identifier on the pipeline row. Earlier code re-derived these
  // from basename(planFile), which broke when planFile reached us via a
  // shell-escaped argv: every `\\` consumed as an escape collapses
  // `C:\\code\\...\\X.md` to `C:code...X.md`, leaving no separators for
  // basename to split on -- so the slug ended up containing the entire
  // stripped path. Using `feature` short-circuits that vulnerability.
  if (!branch)  branch  = `autonomous/${feature}`;

  const cfg = _cfg ?? loadPipelineConfig();
  if (!reviewSkill) {
    const skill = cfg.review?.skill     ?? "/code-review";
    const flag  = cfg.review?.deep_flag ?? "";
    reviewSkill = `${skill} ${flag}`.trim();
  }

  const date = _todayStr();
  const sessionSlug = `${sessionType}-${date}-${feature}`;

  // Plan content is the user's plan file. Relative paths route through
  // resolvePlanFile → resolvePlansDir, which honours cfg.plansDir (so an
  // operator with plans in a sibling repo sees the right file).
  const planPath = resolvePlanFile(planFile, { project, projectRoot, _config: cfg });
  const planContent = existsSync(planPath) ? readFileSync(planPath, "utf8") : "";

  const templatePath = _resolveTemplatePath(sessionType, cfg);
  const template = readFileSync(templatePath, "utf8");

  // Shared progress-tracking block — single source of truth used by every
  // session template via the {{PROGRESS_TRACKING}} placeholder. Lives next
  // to the session templates so an operator's `session_templates_dir`
  // override can replace just this one block.
  const progressPath = _resolvePartialPath("_progress-tracking.md", cfg);
  const progressBlock = existsSync(progressPath) ? readFileSync(progressPath, "utf8").trimEnd() : "";

  // Phase 3b: single worktree per feature. CODE_REVIEW_WT and QA_TEST_WT are
  // load-bearing aliases for WORKTREE — dev-session.md's prior-report-discovery
  // blocks still reference the legacy names; they must keep resolving to the
  // same path until every template migrates. See plugins/pipeline/CLAUDE.md.
  const worktree       = featureWorktreePath({ project, projectRoot, feature, _config: cfg });
  const reviewRP       = reportPath({ project, projectRoot, kind: "code-review", feature, _config: cfg });
  const testRP         = reportPath({ project, projectRoot, kind: "qa-test",     feature, _config: cfg });

  // When re-spawning after QA failure, find and surface the prior test report
  let priorTestFeedbackBlock = "";
  if (devRetries > 0) {
    const reportPath = _findMostRecentTestReport(feature, testRP.dir);
    if (reportPath) {
      priorTestFeedbackBlock = `## Prior test feedback

Attempt ${devRetries} of ${devRetryBudget}. Prior attempt failed QA — read this before starting:
\`${reportPath}\`

`;
    }
  }

  const content = _expand(template, {
    PROGRESS_TRACKING: progressBlock,
    PIPELINE_BIN:      _PIPELINE_BIN,
    SESSION_TYPE:      sessionType,
    FEATURE:           feature,
    PROJECT:           project,
    PROJECT_ROOT:      projectRoot,
    PLAN_PATH:         planPath,
    PLAN_CONTENT:      planContent,
    CORRELATION_ID:    sessionSlug,
    BRANCH:            branch,
    CWD:               cwd || "",
    TARGET_BRANCH:     targetBranch,
    REVIEW_SKILL:      reviewSkill,
    REVIEW_RETRIES:    reviewRetries,
    DEV_RETRIES:       devRetries,
    DEV_RETRY_BUDGET:  devRetryBudget,
    PRIOR_TEST_FEEDBACK: priorTestFeedbackBlock,
    WORKTREE:          worktree,
    CODE_REVIEW_WT:    worktree,
    QA_TEST_WT:        worktree,
    REVIEW_REPORTS_DIR:    reviewRP.dir,
    TEST_REPORTS_DIR:      testRP.dir,
    REVIEW_PUBLISH_BRANCH: reviewRP.publishBranch,
    TEST_PUBLISH_BRANCH:   testRP.publishBranch,
  });

  const sessionsDir = join(projectRoot, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionPath = join(sessionsDir, sessionSlug + ".md");
  writeFileSync(sessionPath, content, "utf8");
  return sessionPath;
}

// Resolve a session file path for a given pipeline row + project. If the
// row's notes carry an explicit session-file ref, use that. Otherwise
// generate a fresh session via the template.
export function resolveSessionFile(row, project, { projectRoot, dry, cwd, stageSessionType } = {}) {
  const notes = (row.notes || "").trim();
  const notesPath = notes.split(/\s+/).find((t) => t.endsWith(".md")) || null;
  if (notesPath && projectRoot) {
    const candidate = join(projectRoot, notesPath);
    if (existsSync(candidate)) return candidate;
  }

  if (dry) return null;
  if (!projectRoot) return null;

  const planFile = row.plan || "";
  // Prefer stage-mapped session type; fall back to notes-based lookup.
  const stype = stageSessionType || _sessionTypeFromNotes(notes);
  const feature = row.feature || basename(planFile, ".md");
  const planStem = basename(planFile, ".md");
  const branch = resolveRowBranch(row, planStem);
  const targetBranch = row.target_branch || "main";
  // review_retries flows from the row so the review-session template can stamp
  // the right retry-(N+1) in its report filename (1-based, matching the Slack label)
  // (the reaper looks at the same filename for the "exit 0 with no verdict" branch).
  const reviewRetries = row.review_retries ?? 0;
  // dev_retries flows from the row for prior-test-feedback injection
  const devRetries = row.dev_retries ?? 0;
  const devRetryBudget = row.dev_retry_budget ?? 2;

  return generateSessionFile(project, planFile, stype, { projectRoot, feature, targetBranch, branch, reviewRetries, devRetries, devRetryBudget, cwd });
}

export function validateSessionSlug(sessionFile, planStem) {
  if (!planStem || !sessionFile) return null;
  const stem = basename(String(sessionFile), ".md");
  const parts = stem.split("-");
  if (parts.length < 5 || !["dev", "test", "research", "review"].includes(parts[0])) {
    return null;
  }
  const sessionSlug = parts.slice(4).join("-");
  if (sessionSlug === planStem) return null;
  return (
    `session file slug '${sessionSlug}' does not match plan stem ` +
    `'${planStem}' — orchestrator would create worktree on ` +
    `autonomous/${planStem} but session expects autonomous/${sessionSlug}`
  );
}
