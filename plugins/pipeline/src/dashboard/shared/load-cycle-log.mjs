// Recent cycle-log entries (per Plan #7) — feeds per-row duration / spend /
// outcome history. Default: 20 most recent entries for the project.
import { loadCycleLog } from "../../db/index.mjs";

export function loadRecentCycles(db, project, { feature = null, limit = 20 } = {}) {
  try { return loadCycleLog(db, { project, feature, limit }) || []; }
  catch { return []; }
}
