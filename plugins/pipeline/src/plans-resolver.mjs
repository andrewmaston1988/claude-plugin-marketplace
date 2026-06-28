import { basename, dirname, join } from "node:path";
import { loadPipelineConfig } from "./pipeline-config.mjs";
import { resolveTemplate } from "./worktree-paths.mjs";
import { getPaths } from "./paths.mjs";

// Canonical plans-directory resolver. Precedence + placeholders documented in REFERENCE.md.
//
// Precedence (first hit wins):
//   1. cfg.plansDirs[<project>]    -- per-project override in config.json (preferred)
//   2. projectPlansDir              -- legacy per-project DB column (deprecated; still honoured)
//   3. cfg.plansDir template        -- global default with placeholder vocabulary
//   4. "plans" literal joined to projectRoot
export function resolvePlansDir({ project, projectRoot, projectPlansDir, _config } = {}) {
  const cfg = _config ?? loadPipelineConfig();
  const paths = getPaths();
  const projectName = project || (projectRoot ? basename(projectRoot) : "");
  const vars = {
    root:             projectRoot || "",
    root_parent:      projectRoot ? dirname(projectRoot) : "",
    root_grandparent: projectRoot ? dirname(dirname(projectRoot)) : "",
    project:          projectName,
  };
  const opts = { resolveBase: projectRoot, configDir: paths.configDir };

  const configOverride = projectName ? cfg?.plansDirs?.[projectName] : null;
  if (configOverride) return resolveTemplate(configOverride, vars, opts);

  if (projectPlansDir) return projectPlansDir;

  const template = cfg?.plansDir || "plans";
  return resolveTemplate(template, vars, opts);
}

// Absolute paths pass through; bare filenames join under the resolved plans dir.
export function resolvePlanFile(planFile, opts = {}) {
  if (!planFile) return planFile;
  if (planFile.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(planFile)) return planFile;
  return join(resolvePlansDir(opts), planFile);
}
