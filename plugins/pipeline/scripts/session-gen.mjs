import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipelineConfig } from "../src/pipeline-config.mjs";
import { reportPath, handlerWorktreePath, resolveTemplate } from "./worktree-paths.mjs";
import { getPaths } from "../src/paths.mjs";

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
    // Global / install-wide key per §B → resolves against paths.configDir.
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
    _cfg,
  } = {}
) {
  if (!projectRoot) throw new Error("generateSessionFile: projectRoot is required");

  if (!planFile.endsWith(".md")) planFile += ".md";
  const planStem = basename(planFile, ".md");
  if (!feature) feature = planStem;
  if (!branch)  branch  = `autonomous/${planStem}`;

  const cfg = _cfg ?? loadPipelineConfig();
  if (!reviewSkill) {
    const skill = cfg.review?.skill     ?? "/code-review";
    const flag  = cfg.review?.deep_flag ?? "";
    reviewSkill = `${skill} ${flag}`.trim();
  }

  const date = _todayStr();
  const sessionSlug = `${sessionType}-${date}-${planStem}`;

  // Plan content is the user's plan file. If the path is relative, resolve
  // it under projectRoot/plans/ — matches the convention rows.mjs uses for
  // the row's plan_file column.
  const planPath = planFile.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(planFile)
    ? planFile
    : join(projectRoot, "plans", planFile);
  const planContent = existsSync(planPath) ? readFileSync(planPath, "utf8") : "";

  const templatePath = _resolveTemplatePath(sessionType, cfg);
  const template = readFileSync(templatePath, "utf8");

  // Shared progress-tracking block — single source of truth used by every
  // session template via the {{PROGRESS_TRACKING}} placeholder. Lives next
  // to the session templates so an operator's `session_templates_dir`
  // override can replace just this one block.
  const progressPath = _resolvePartialPath("_progress-tracking.md", cfg);
  const progressBlock = existsSync(progressPath) ? readFileSync(progressPath, "utf8").trimEnd() : "";

  const codeReviewWt   = handlerWorktreePath({ project, projectRoot, kind: "code-review", feature, _config: cfg });
  const qaTestWt       = handlerWorktreePath({ project, projectRoot, kind: "qa-test",     feature, _config: cfg });
  const reviewReports  = reportPath({ project, projectRoot, kind: "code-review", feature, _config: cfg }).dir;
  const testReports    = reportPath({ project, projectRoot, kind: "qa-test",     feature, _config: cfg }).dir;

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
    CODE_REVIEW_WT:    codeReviewWt,
    QA_TEST_WT:        qaTestWt,
    REVIEW_REPORTS_DIR: reviewReports,
    TEST_REPORTS_DIR:   testReports,
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
export function resolveSessionFile(row, project, { projectRoot, dry, cwd } = {}) {
  const notes = (row.notes || "").trim();
  const notesPath = notes.split(/\s+/).find((t) => t.endsWith(".md")) || null;
  if (notesPath && projectRoot) {
    const candidate = join(projectRoot, notesPath);
    if (existsSync(candidate)) return candidate;
  }

  if (dry) return null;
  if (!projectRoot) return null;

  const planFile = row.plan || "";
  const stype = _sessionTypeFromNotes(notes);
  const feature = row.feature || basename(planFile, ".md");
  const targetBranch = row.target_branch || "main";
  // review_retries flows from the row so the review-session template can stamp
  // the right retry-N in its report filename (the reaper looks at the same
  // filename for the "exit 0 with no verdict" branch).
  const reviewRetries = row.review_retries ?? 0;

  return generateSessionFile(project, planFile, stype, { projectRoot, feature, targetBranch, reviewRetries, cwd });
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
