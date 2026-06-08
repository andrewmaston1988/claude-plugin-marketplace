// Tokyo Night palette + stage labels + spinner frame sets shared by the
// TUI render loop and the web dashboard. Anything visual the user sees
// resolves through one of these constants.

export const C_BG          = "#1e2030";
export const C_BORDER_ACT  = "#7aa2f7";
export const C_BORDER_IDLE = "#38597b";
export const C_HEADER_HL   = "#8e5b4e";
export const C_TEXT        = "#afb9d8";
export const C_DIM         = "#4a5a78";
export const C_GREEN       = "#95b170";
export const C_YELLOW      = "#e0af68";
export const C_RED         = "#c25c66";
export const C_CYAN        = "#7dcfff";
export const C_PURPLE      = "#c099ff";
export const C_HASH        = "#e0af68";
export const C_KEY_BG      = "#38597b";
export const C_SELECTED    = "#2a3b5c";

// Stage label + color used everywhere a stage is rendered.
//   merge / manual / test / dev / research / queued / backlog / done
// Stage labels are bare names, no emoji — the TUI uses STAGE_COLOR to
// distinguish them. Emoji-prefixed labels would consume extra width and
// don't render reliably across the terminal+font combinations we target.
export const STAGE_STYLE = {
  merge:    { label: "merge",    color: C_GREEN,  bold: true },
  manual:   { label: "manual",   color: C_YELLOW, bold: true },
  test:     { label: "test",     color: C_CYAN,   bold: false },
  dev:      { label: "dev",      color: C_TEXT,   bold: false },
  research: { label: "research", color: C_PURPLE, bold: false },
  review:   { label: "review",   color: C_CYAN,   bold: false },
  queued:   { label: "queued",   color: C_DIM,    bold: false },
  backlog:  { label: "backlog",  color: C_DIM,    bold: false },
  done:     { label: "done",     color: C_DIM,    bold: false },
};

// Display order for the rows table.
export const STAGE_ORDER = ["merge", "manual", "test", "review", "dev", "research", "queued", "backlog", "done"];

// Stage → display color (used by shimmer effect on the stage label,
// and for the inprog spinner color in the agents panel). `review` is
// deliberately UNMAPPED so STAGE_COLOR[stype] || C_GREEN fallback turns
// review spinners green.
export const STAGE_COLOR = {
  merge:    C_GREEN,
  manual:   C_YELLOW,
  test:     C_CYAN,
  dev:      C_TEXT,
  research: C_PURPLE,
  queued:   C_DIM,
  backlog:  C_DIM,
  done:     C_DIM,
};

// Spinner frames + tick rates (ticks per second).
export const SPIN_FRAMES        = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPIN_TICK_HZ       = 9;
export const QUEUE_SPIN_FRAMES  = ["⠁", "⠂", "⠄", "⠂"];
export const QUEUE_SPIN_TICK_HZ = 3;
export const CLAUDE_SPIN_FRAMES = ["·", "*", "+", "✧", "✶", "✸", "✲", "✻", "❊", "✽", "❋", "❆", "❋", "✽", "❊", "✻", "✲", "✸", "✶", "✧", "+", "*", "·"];
export const CLAUDE_SPIN_TICK_HZ = 6;

// Shimmer amplitudes — 0.25 keeps the running-label sweep subtle so it
// reads as activity rather than alarm; 0.45 on stage transitions decays
// over 60s so a stage change is briefly attention-grabbing then fades.
export const SHIMMER_AMP_RUN   = 0.25;   // running-label shimmer
export const SHIMMER_AMP_STAGE = 0.45;   // stage-label shimmer (fades over 60s)
export const SHIMMER_FADE_SECS = 60;

// Marquee defaults (matches _marquee).
export const MARQUEE_WIDTH = 48;
export const MARQUEE_SPEED = 5.0;
export const MARQUEE_SEP   = "   ·   ";

// blessed tag helpers. `{/}` is the concise cancel — blessed's parser
// doesn't support hex-named closers like `{/#hex-fg}`, those leave the
// attr open until end of buffer.
export function fg(hex, s) {
  return `{${hex}-fg}${s}{/}`;
}
export function bg(hex, s) {
  return `{${hex}-bg}${s}{/}`;
}
export function bold(s) {
  return `{bold}${s}{/bold}`;
}

// Render a stage cell with the canonical label + color (no shimmer; the
// shimmer variant lives in anim.mjs and pulses on the stage that's
// currently transitioning).
export function stageMarkup(stage) {
  const style = STAGE_STYLE[stage] || { label: stage, color: C_TEXT };
  const inner = style.bold ? bold(style.label) : style.label;
  return fg(style.color, inner);
}
