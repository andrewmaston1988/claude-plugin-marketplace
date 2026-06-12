// Tokyo Night palette + stage labels + spinner frame sets shared by the
// TUI render loop and the web dashboard. Anything visual the user sees
// resolves through one of these constants.

import { PALETTE } from "../shared/view-model/glyph.mjs";

export const C_BG          = "#1e2030";
export const C_BORDER_ACT  = "#7aa2f7";
export const C_BORDER_IDLE = "#38597b";
export const C_HEADER_HL   = PALETTE.headerHl;
export const C_TEXT        = PALETTE.text;
export const C_DIM         = PALETTE.dim;
export const C_GREEN       = PALETTE.green;
export const C_YELLOW      = PALETTE.yellow;
export const C_RED         = PALETTE.red;
export const C_CYAN        = PALETTE.cyan;
export const C_PURPLE      = PALETTE.purple;
export const C_HASH        = "#e0af68";
export const C_KEY_BG      = "#38597b";
export const C_SELECTED    = "#2a3b5c";

// Stage label/color/order are semantic decisions shared with the web
// dashboard — canonical definitions live in the shared view-model layer.
// Imported (stageMarkup below uses STAGE_STYLE) and re-exported so TUI
// modules keep a single import surface for styling.
import { STAGE_STYLE, STAGE_ORDER, STAGE_COLOR } from "../shared/view-model/glyph.mjs";
export { STAGE_STYLE, STAGE_ORDER, STAGE_COLOR };

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

// Neutralise literal braces in dynamic/untrusted text (log lines, commit
// messages, feature names, notes) before it is composed into tagged content.
// blessed parses any `{...}` matching /{\/?[\w\-,;!#]*}/ as markup; a data
// sequence like `{a;b}` is read as a multi-part colour tag and throws inside
// blessed's _attr() on a null `.slice` (program.js). `{open}`/`{close}` are
// blessed's own escapes for a literal `{`/`}`, so the text round-trips intact.
export function escapeTags(s) {
  return String(s ?? "").replace(/[{}]/g, (ch) => (ch === "{" ? "{open}" : "{close}"));
}

// Render a stage cell with the canonical label + color (no shimmer; the
// shimmer variant lives in anim.mjs and pulses on the stage that's
// currently transitioning).
export function stageMarkup(stage) {
  const style = STAGE_STYLE[stage] || { label: stage, color: C_TEXT };
  const inner = style.bold ? bold(style.label) : style.label;
  return fg(style.color, inner);
}
