import { readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { projectGetByName } from "../../../scripts/pipeline-db/projects.mjs";
import { rowsList } from "../../../scripts/pipeline-db/rows.mjs";

// Load backlog rows (unqueued plan files) for a project.
// Returns array of virtual rows: {feature, stage, plan_file, branch, notes_extra, virtual}
export function loadBacklog(db, projectName) {
  const project = projectGetByName(db, projectName);
  if (!project) return [];

  // Resolve plans_dir: use project's explicit plans_dir if set, otherwise <root_path>/plans/
  const plansDir = project.plans_dir || resolve(project.root_path, "plans");
  if (!existsSync(plansDir)) return [];

  try {
    const files = readdirSync(plansDir, { withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith(".md"))
      .map(d => d.name);

    if (files.length === 0) return [];

    // Fetch all queued rows for this project to exclude them
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
