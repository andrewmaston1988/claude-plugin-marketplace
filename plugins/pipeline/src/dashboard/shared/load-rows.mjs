// Load pipeline rows for the dashboard. Wraps rowsList for one project; also
// exposes a multi-project loader for project switching.
import { rowsList } from "../../../scripts/pipeline-db/index.mjs";
import { projectList } from "../../../scripts/pipeline-db/projects.mjs";

export function loadProjects(db, { enabledOnly = true } = {}) {
  return (projectList(db) || []).filter(p => !enabledOnly || p.enabled === 1);
}

export function loadRows(db, project, { showAll = false } = {}) {
  const opts = showAll ? {} : { excludeStages: ["done"] };
  return rowsList(db, project, opts) || [];
}
