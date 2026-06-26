// Active sessions for a project — what's running right now per row.
import { sessionsActive } from "../../db/index.mjs";

export function loadActiveSessions(db, project) {
  try { return sessionsActive(db, project) || []; }
  catch { return []; }
}
