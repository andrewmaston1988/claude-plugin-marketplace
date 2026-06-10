import { basename, dirname, join } from "node:path";
import { loadPipelineConfig } from "./pipeline-config.mjs";
import { resolveTemplate } from "../scripts/worktree-paths.mjs";
import { getPaths } from "./paths.mjs";

// Resolve a project's plans directory. Single source of truth for every
// consumer (rows, dashboard backlog, session-gen, demo, …).
//
// Precedence:
//   1. `projectPlansDir` — project-row plans_dir column (absolute, literal).
//   2. `cfg.plansDir`    — template with placeholders, resolved against projectRoot.
//   3. `<projectRoot>/plans` — historical default.
//
// Placeholders honoured: {root}, {root_parent}, {root_grandparent}, {project}.
// Returns an absolute path. _config is a test-injection point.
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

// Resolve a plan file reference. Mirrors the row-spawn convention: absolute /
// drive-letter paths pass through; bare filenames or relative paths resolve
// under the project's plans directory.
export function resolvePlanFile(planFile, opts = {}) {
  if (!planFile) return planFile;
  if (planFile.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(planFile)) return planFile;
  return join(resolvePlansDir(opts), planFile);
}
