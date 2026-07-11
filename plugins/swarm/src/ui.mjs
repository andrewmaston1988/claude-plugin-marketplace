// Terminal styling for swarm's stdout. Colour is a TTY-only garnish: when
// stdout is piped (a session's Bash capture, tests, CI) every helper returns
// its input verbatim, so the stdout CONTRACT stays byte-identical and parsers
// never see ANSI. NO_COLOR (https://no-color.org) is honoured on TTYs too.

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
  blocked: magenta,
  skipped: dim,
  running: cyan,
  pending: dim,
};

export function paint(state, s) {
  return (stateColor[state] || ((x) => x))(s);
}

// Repainting writer for roster snapshots. On a TTY each snapshot erases the
// previous one (cursor-up + clear-to-end) so the roster updates in place; when
// piped, snapshots append separated by a blank line — the tail of the buffer
// is always the latest full picture.
export function createSnapshotWriter({ write = (s) => process.stdout.write(s), isTTY = process.stdout.isTTY } = {}) {
  let prevLines = 0;
  return (block) => {
    const erase = isTTY && prevLines > 0 ? `\x1b[${prevLines}A\x1b[0J` : "";
    write(erase + block + "\n" + (isTTY ? "" : "\n"));
    prevLines = block.split("\n").length;
  };
}
