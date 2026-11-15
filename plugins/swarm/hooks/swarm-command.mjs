// The one description of a swarm command word, shared by the PreToolUse gates.
// Two spellings: `node … swarm.mjs <sub>` and the PATH shim `swarm <sub>`
// (swarm.cmd / swarm.ps1), bare or path-qualified. Anchored on command position:
// start, or after `;`, `&&`, `||`, `|` or `(`. `lineBreak: true` also admits a line
// break (output guard); without it, a commit-body line is not a call (dispatch-gate).
const DISPATCH_WORD = String.raw`(?:node(?:\.exe)?\s+["']?[^"'\s]*swarm\.mjs["']?|["']?(?:[^"'\s]*[\\/])?swarm(?:\.cmd|\.ps1)?["']?)`;

const ANCHOR = String.raw`(?:^|;|&&|\|\||\||\()`;
const ANCHOR_LINE_BREAK = String.raw`(?:^|;|&&|\|\||\||\(|\n)`;

/** Anchored pattern for `<engine word> <sub>`, e.g. swarmSubcommandRe("run", { lineBreak: false }). */
export function swarmSubcommandRe(sub, { lineBreak }) {
  return new RegExp(`${lineBreak ? ANCHOR_LINE_BREAK : ANCHOR}\\s*(?:nohup\\s+)?${DISPATCH_WORD}\\s+${sub}\\b`);
}
