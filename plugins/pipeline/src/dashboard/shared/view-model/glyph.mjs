// Canonical stage palette + per-session glyph derivation, shared by the TUI
// and web dashboards. This module owns every *semantic* visual decision —
// which color a stage maps to, what state a session is in, which glyph that
// state earns. Renderers translate the returned hex/char fields into blessed
// markup or HTML; they make no derivation decisions of their own.
//
// History: this logic previously lived twice (tui/app.mjs _sessionGlyph and
// the served client JS in web/templates.mjs sessionGlyph) and the two copies
// drifted repeatedly — the progress-key bug alone recurred four times. Keep
// it here, keep it pure, keep it tested.

export const PALETTE = Object.freeze({
  text:     "#afb9d8",
  dim:      "#4a5a78",
  green:    "#95b170",
  yellow:   "#e0af68",
  red:      "#c25c66",
  cyan:     "#7dcfff",
  purple:   "#c099ff",
  headerHl: "#8e5b4e",
});

// Stage label + color used everywhere a stage is rendered.
export const STAGE_STYLE = Object.freeze({
  merge:    { label: "merge",    color: PALETTE.green,  bold: true },
  manual:   { label: "manual",   color: PALETTE.yellow, bold: true },
  test:     { label: "test",     color: PALETTE.cyan,   bold: false },
  dev:      { label: "dev",      color: PALETTE.text,   bold: false },
  research: { label: "research", color: PALETTE.purple, bold: false },
  review:   { label: "review",   color: PALETTE.cyan,   bold: false },
  queued:   { label: "queued",   color: PALETTE.dim,    bold: false },
  backlog:  { label: "backlog",  color: PALETTE.dim,    bold: false },
  done:     { label: "done",     color: PALETTE.dim,    bold: false },
});

// Display order for the rows table.
export const STAGE_ORDER = Object.freeze(
  ["merge", "manual", "test", "review", "dev", "research", "queued", "backlog", "done"],
);

// Stage → display color. `review` is deliberately UNMAPPED so
// STAGE_COLOR[stype] || PALETTE.green turns review spinners green.
export const STAGE_COLOR = Object.freeze({
  merge:    PALETTE.green,
  manual:   PALETTE.yellow,
  test:     PALETTE.cyan,
  dev:      PALETTE.text,
  research: PALETTE.purple,
  queued:   PALETTE.dim,
  backlog:  PALETTE.dim,
  done:     PALETTE.dim,
});

const STALLED_SECS = 30 * 60;

// Semantic session state. Order matters: dead > stalled > working > waiting
// > finished > idle.
//
// Deadness combines the two rules the surfaces previously disagreed on:
// is_active === 0 from the DB always means dead; a live-looking row with a
// real PID (> 4 — small values are mock PIDs from tests/demo) is probed via
// `pidAlive` when the caller supplies one. The web client used to skip the
// PID probe entirely (it can't signal processes); now the server computes
// this model so both surfaces get the same answer.
export function sessionState(session, prog, { now = Date.now(), pidAlive } = {}) {
  const spawnMs = Date.parse(session.spawn_time) || now;
  const ageSecs = (now - spawnMs) / 1000;
  const dead = session.is_active === 0
    || (typeof pidAlive === "function" && session.pid > 4 && !pidAlive(session.pid));
  const inprog   = prog.inprog > 0;
  const finished = !prog.todo && !prog.inprog && prog.done > 0;
  if (dead)                              return "dead";
  if (inprog && ageSecs > STALLED_SECS)  return "stalled";
  if (inprog)                            return "working";
  if (session.is_active === 1)           return "waiting";
  if (finished)                          return "finished";
  return "idle";
}

// State → glyph descriptor. `spinning: true` means the renderer animates its
// own spinner frames in `glyphColor`; `char` is only set for static states.
export function sessionGlyph(state, stageColor) {
  switch (state) {
    case "dead":     return { char: "✗", spinning: false, glyphColor: PALETTE.red,    nameColor: PALETTE.red,  timeColor: PALETTE.red };
    case "stalled":  return { char: "●", spinning: false, glyphColor: PALETTE.yellow, nameColor: PALETTE.yellow, timeColor: PALETTE.yellow };
    case "working":  return { char: null, spinning: true, glyphColor: stageColor,     nameColor: PALETTE.text, timeColor: stageColor };
    case "waiting":  return { char: null, spinning: true, glyphColor: PALETTE.dim,    nameColor: PALETTE.text, timeColor: PALETTE.dim };
    case "finished": return { char: "✓", spinning: false, glyphColor: PALETTE.dim,    nameColor: PALETTE.dim,  timeColor: PALETTE.dim };
    default:         return { char: "·", spinning: false, glyphColor: PALETTE.dim,    nameColor: PALETTE.text, timeColor: PALETTE.dim };
  }
}
