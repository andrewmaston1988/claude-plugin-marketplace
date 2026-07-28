// Terminal styling for swarm's stdout. Colour is a TTY-only garnish: when
// stdout is piped (a session's Bash capture, tests, CI) every helper returns
// its input verbatim, so the stdout CONTRACT stays byte-identical and parsers
// never see colour. NO_COLOR (https://no-color.org) is honoured on TTYs too.
// Cursor control is decided separately and CAN reach a pipe — see
// repaintsInPlace below; SWARM_REPAINT=0 is the switch for a parser that must
// see no ANSI at all.

const on = () => process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code) => (s) => (on() ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold    = wrap("1");
export const dim     = wrap("2");
export const green   = wrap("32");
export const red     = wrap("31");
export const yellow  = wrap("33");
export const magenta = wrap("35");
export const cyan    = wrap("36");

// State → colourer, aligned with the GLYPHS table in results.mjs.
export const stateColor = {
  ok: green,
  failed: red,
  "failed:timeout": red,
  "rate-limited": yellow,
  quota: yellow,
  retrying: yellow,
  blocked: magenta,
  skipped: dim,
  running: cyan,
  pending: dim,
};

export function paint(state, s) {
  return (stateColor[state] || ((x) => x))(s);
}

// Does this stdout destination render cursor movement? A real TTY does, and so
// does the Claude Code harness live view — it interprets cursor-up +
// clear-to-end even though the run's stdout is a pipe (measured against a live
// background-task view, 2026-07-28). Everything else — file redirects, CI logs,
// test capture — must stay byte-clean, so it appends instead.
// SWARM_REPAINT=1/0 forces either side for destinations we can't sniff.
export function repaintsInPlace({ isTTY, env = process.env } = {}) {
  if (env.SWARM_REPAINT === "1") return true;
  if (env.SWARM_REPAINT === "0") return false;
  return Boolean(isTTY) || env.CLAUDECODE === "1";
}

// The harness live view is a fixed-height window onto the buffer — 9 rows,
// measured 2026-07-28. Erasing exactly what we wrote keeps net growth at zero,
// so the block repaints in place, but the window height cuts both ways:
//   - a TALLER block loses its header and top rows off the top
//     → renderRoster compacts to this budget (see maxLines there)
//   - a SHORTER block leaves rows above it that the erase never rewrites, so
//     they freeze → the writer fills the block out to this height
export const HARNESS_WINDOW_LINES = 9;

function windowLines(env) {
  const n = Number(env.SWARM_WINDOW_LINES);
  return Number.isFinite(n) && n > 0 ? n : HARNESS_WINDOW_LINES;
}

// Height the live view can actually show, for callers that must render to fit.
// Null wherever the roster is never clipped: a TTY scrolls, a plain pipe appends.
export function liveViewLines({ isTTY = process.stdout.isTTY, env = process.env } = {}) {
  return !isTTY && repaintsInPlace({ isTTY, env }) ? windowLines(env) : null;
}

// Repainting writer for roster snapshots. Where the destination repaints, each
// snapshot erases the previous one so the roster updates in place and the
// operator sees exactly one live block. Where it does not, snapshots append
// plainly and the tail of the buffer is the latest full picture. No blank line
// between snapshots: an appending view shows only the tail, so every blank
// costs a row of it.
export function createSnapshotWriter({
  write = (s) => process.stdout.write(s),
  isTTY = process.stdout.isTTY,
  env = process.env,
} = {}) {
  const repaint = repaintsInPlace({ isTTY, env });
  // Fill the windowed view, so no stale row survives above the roster. The
  // filler goes BELOW: the roster then sits at the top of the window with empty
  // space beneath it, rather than being pushed down by leading blanks. A TTY
  // scrolls and needs none of this.
  const fillTo = repaint && !isTTY ? windowLines(env) : 0;
  let prevLines = 0;
  return (block) => {
    const lines = block.split("\n").length;
    const filler = "\n".repeat(Math.max(0, fillTo - lines));
    const erase = repaint && prevLines > 0 ? `\x1b[${prevLines}A\x1b[0J` : "";
    write(erase + block + filler + "\n");
    prevLines = Math.max(lines, fillTo);
  };
}
