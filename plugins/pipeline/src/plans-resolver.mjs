import { basename, dirname, join } from "node:path";
import { loadPipelineConfig } from "./pipeline-config.mjs";
import { resolveTemplate } from "./worktree-paths.mjs";
import { getPaths } from "./paths.mjs";

// The subset of PLACEHOLDER_KEYS resolvePlansDir actually supplies. Anything else in a
// plansDir template is unresolvable however legal it looks against the global vocabulary.
// Must stay in step with the `vars` object below.
export const PLANS_DIR_KEYS = Object.freeze([
  "root", "root_parent", "root_grandparent", "project", "config_dir",
]);

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

  // Substituted like every other tier: an absolute value passes through unchanged, and a
  // template in this column would otherwise reach callers with its placeholders intact.
  if (projectPlansDir) return resolveTemplate(projectPlansDir, vars, opts);

  const template = cfg?.plansDir || "plans";
  return resolveTemplate(template, vars, opts);
}

// Absolute paths pass through; bare filenames join under the resolved plans dir.
export function resolvePlanFile(planFile, opts = {}) {
  if (!planFile) return planFile;
  if (planFile.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(planFile)) return planFile;
  return join(resolvePlansDir(opts), planFile);
}
