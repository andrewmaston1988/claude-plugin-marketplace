import { readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { projectGetByName } from "../../db/projects.mjs";
import { rowsList } from "../../db/rows.mjs";
import { resolvePlansDir } from "../../plans-resolver.mjs";

// Load backlog rows (unqueued plan files) for a project.
// Returns array of virtual rows: {feature, stage, plan_file, branch, notes_extra, virtual}
export function loadBacklog(db, projectName, _cfg) {
  const project = projectGetByName(db, projectName);
  if (!project) return [];

  const plansDir = resolvePlansDir({
    project:         projectName,
    projectRoot:     project.root_path,
    projectPlansDir: project.plans_dir,
    _config:         _cfg,
  });
  if (!plansDir || !existsSync(plansDir)) return [];

  try {
    const files = readdirSync(plansDir, { withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith(".md"))
      .map(d => d.name);

    if (files.length === 0) return [];

    const queued = new Set(rowsList(db, projectName).map(r => r.feature));

    return files
      .filter(f => !queued.has(f.replace(/\.md$/, "")))
      .map(f => ({
        feature: f.replace(/\.md$/, ""),
        stage: "backlog",
        plan_file: resolve(plansDir, f),
        branch: "—",
        notes_extra: null,
        virtual: true,
      }));
  } catch (e) {
    console.error(`loadBacklog: error reading ${plansDir}:`, e.message);
    return [];
  }
}
