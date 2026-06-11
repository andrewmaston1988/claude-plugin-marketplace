// Agents-panel view model — one entry per active session, fully derived.
// Owns the progress-lookup keying contract (progressKey → correlation_id);
// see load-progress.mjs for why that key and no other.
import { progressKey } from "../load-progress.mjs";
import { PALETTE, STAGE_COLOR, sessionState, sessionGlyph } from "./glyph.mjs";
import { fmtAge } from "./util.mjs";

const EMPTY_PROGRESS = Object.freeze({ step: 0, total: 0, done: 0, inprog: 0, todo: 0 });

// sessions: rows from loadActiveSessions. progressBySlug: map from
// loadProgressBySlug. Returns only active sessions, in input order.
export function agentsViewModel(sessions, progressBySlug, { now = Date.now(), pidAlive } = {}) {
  return (sessions || [])
    .filter(s => s.is_active === 1)
    .map(s => {
      const sessionType = s.session_type || "dev";
      const stageColor  = STAGE_COLOR[sessionType] || PALETTE.green;
      const progress    = progressBySlug?.[progressKey(s)] || EMPTY_PROGRESS;
      const state       = sessionState(s, progress, { now, pidAlive });
      return {
        feature: s.feature,
        sessionType,
        stageColor,
        progress,
        state,
        glyph: sessionGlyph(state, stageColor),
        age: fmtAge(s.spawn_time, now),
      };
    });
}
