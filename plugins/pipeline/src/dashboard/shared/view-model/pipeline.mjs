// Pipeline-panel view model — sort order, counts, and per-row semantic
// derivation (blocked / parked / qa-fail / queued-type substitution / icon
// precedence). Previously derived independently by tui/app.mjs
// (_stageCell/_iconCell/_sortRows) and the served client JS in
// web/templates.mjs, which drifted.
import { PALETTE, STAGE_STYLE, STAGE_ORDER, STAGE_COLOR } from "./glyph.mjs";

export function sortRows(rows) {
  return (rows || []).slice().sort((a, b) => {
    const ai = STAGE_ORDER.indexOf(a.stage);
    const bi = STAGE_ORDER.indexOf(b.stage);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

// Stage-transition tracking for the shimmer effect. Stateful by necessity —
// a transition is a difference between consecutive refreshes — so callers
// hold one tracker per project and feed it every refresh.
export function createTransitionTracker() {
  const lastStages  = new Map();
  const transitions = new Map();
  return {
    track(rows, now = Date.now()) {
      const seen = new Set();
      for (const r of rows || []) {
        seen.add(r.feature);
        const prev = lastStages.get(r.feature);
        if (prev !== undefined && prev !== r.stage) transitions.set(r.feature, now);
        lastStages.set(r.feature, r.stage);
      }
      for (const k of [...lastStages.keys()]) {
        if (!seen.has(k)) { lastStages.delete(k); transitions.delete(k); }
      }
    },
    elapsedSecs(feature, now = Date.now()) {
      const t = transitions.get(feature);
      return t ? (now - t) / 1000 : Infinity;
    },
  };
}

const SHIMMER_SECS = 60;

// rows: merged pipeline + backlog rows (unsorted is fine). sessions: rows
// from loadActiveSessions — used to spin the icon of features with a live
// session. tracker: optional createTransitionTracker() instance.
export function pipelineViewModel(rows, { showAll = false, sessions = [], tracker, now = Date.now() } = {}) {
  const all = rows || [];
  const counts = {
    queued: all.filter(r => r.stage === "queued").length,
    done:   all.filter(r => r.stage === "done").length,
  };

  let visible = sortRows(all);
  if (!showAll) visible = visible.filter(r => r.stage !== "done");
  counts.active = visible.filter(r => r.stage !== "done" && r.stage !== "queued").length;

  tracker?.track(visible, now);

  // Feature → running session type, for icon spinners. Session-file slug is
  // `<type>-<date>-<feature>`; fall back to the session_type column.
  const slugRe = /^(dev|test|research|review)-\d{4}-\d{2}-\d{2}-(.+)$/;
  const runningTypeByFeature = new Map();
  for (const s of sessions) {
    if (s.is_active !== 1 || !s.feature) continue;
    const base = String(s.session_file || "").split(/[\\/]/).pop()?.replace(/\.md$/, "") || "";
    const m = slugRe.exec(base);
    runningTypeByFeature.set(s.feature, m ? m[1] : (s.session_type || "dev"));
  }

  const modelRows = visible.map(r => {
    const notes   = r.notes_extra || "";
    const qaFail  = r.qa_pass === 0;
    const blocked = r.stage === "manual" && notes.startsWith("blocked:");
    const parked  = r.stage === "manual" && /\[parked-review-budget-exhausted/.test(notes);

    // Stage cell: queued rows substitute the queued-type label (from notes);
    // active-stage rows use the stage directly; parked rows render as "blocked"
    // (red, bold) — both blocked: notes and the parked marker mean "needs human
    // triage", the only distinction the dashboard owes the operator.
    let stageLabel = STAGE_STYLE[r.stage]?.label || r.stage;
    let stageColor = STAGE_COLOR[r.stage] || PALETTE.text;
    let stageBold  = !!STAGE_STYLE[r.stage]?.bold;
    if (qaFail || blocked) stageColor = PALETTE.red;
    // For queued rows, fall back to type= in notes; for active stages, use the stage directly.
    if (r.stage === "queued") {
      const m = /\btype=(\w+)\b/.exec(notes);
      if (m) {
        stageLabel = STAGE_STYLE[m[1]]?.label || m[1];
        stageColor = STAGE_COLOR[m[1]] || PALETTE.dim;
      }
    }
    if (parked) {
      stageLabel = "blocked";
      stageColor = PALETTE.red;
      stageBold  = true;
    }

    // Icon precedence: blocked > live-session spinner > qa-fail > queued.
    // A row parked at manual must not look "running" off a stale session row.
    let icon = null, iconColor = null;
    const runningType = runningTypeByFeature.get(r.feature);
    if (blocked || parked)           { icon = "blocked"; iconColor = PALETTE.red; }
    else if (runningType)            { icon = "spin";    iconColor = STAGE_COLOR[runningType] || PALETTE.green; }
    else if (qaFail)                 { icon = "fail";    iconColor = PALETTE.red; }
    else if (r.stage === "queued")   {
      const m = /\btype=(\w+)\b/.exec(notes);
      icon = "queue";
      iconColor = m ? (STAGE_COLOR[m[1]] || PALETTE.dim) : PALETTE.dim;
    }

    const trimmed = notes.trim();
    const elapsed = tracker ? tracker.elapsedSecs(r.feature, now) : Infinity;
    return {
      feature: r.feature,
      stage: r.stage,
      stageLabel,
      stageColor,
      stageBold,
      italic: r.stage === "backlog",
      qaFail,
      blocked: blocked || parked,
      icon,
      iconColor,
      featureColor: (qaFail || blocked) ? PALETTE.red : (STAGE_COLOR[r.stage] || PALETTE.text),
      notesColor: blocked ? PALETTE.red : PALETTE.dim,
      notes: trimmed.startsWith("type=") ? "" : trimmed,
      // Seconds since the row's last stage transition, or null when outside
      // the shimmer window. The TUI uses the value for fade amplitude; the
      // web only needs the null check.
      shimmerSecs: elapsed < SHIMMER_SECS ? elapsed : null,
    };
  });

  return { counts, rows: modelRows };
}
