import { basename, dirname, join } from "node:path";
import { loadPipelineConfig } from "./pipeline-config.mjs";
import { resolveTemplate } from "../scripts/worktree-paths.mjs";
import { getPaths } from "./paths.mjs";

// Canonical plans-directory resolver. Precedence + placeholders documented in REFERENCE.md.
export function resolvePlansDir({ project, projectRoot, projectPlansDir, _config } = {}) {
  if (projectPlansDir) return projectPlansDir;
  const cfg = _config ?? loadPipelineConfig();
  const template = cfg?.plansDir || "plans";
  const paths = getPaths();
  const projectName = project || (projectRoot ? basename(projectRoot) : "");
  return resolveTemplate(template, {
    root:             projectRoot || "",
    root_parent:      projectRoot ? dirname(projectRoot) : "",
    root_grandparent: projectRoot ? dirname(dirname(projectRoot)) : "",
    project:          projectName,
  }, {
    resolveBase: projectRoot,
    configDir:   paths.configDir,
  });
}

// Absolute paths pass through; bare filenames join under the resolved plans dir.
export function resolvePlanFile(planFile, opts = {}) {
  if (!planFile) return planFile;
  if (planFile.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(planFile)) return planFile;
  return join(resolvePlansDir(opts), planFile);
}
