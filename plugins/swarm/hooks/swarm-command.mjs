// The one description of a swarm command word, shared by the PreToolUse gates so
// they cannot drift on what counts as a call to the engine.
//
// Two spellings reach it: `node … swarm.mjs <sub>` and the PATH shim `swarm <sub>`
// (swarm.cmd / swarm.ps1), bare or path-qualified. Anchored on command position —
// start, or after `;`, `&&`, `||`, `|`, `(` — so the phrase inside a `git commit -m`
// argument (observed 2026-09-06) is not a call.
const DISPATCH_WORD = String.raw`(?:node(?:\.exe)?\s+["']?[^"'\s]*swarm\.mjs["']?|["']?(?:[^"'\s]*[\\/])?swarm(?:\.cmd|\.ps1)?["']?)`;

/** Anchored pattern for `<engine word> <sub>`, e.g. swarmSubcommandRe("run"). */
export function swarmSubcommandRe(sub) {
  return new RegExp(String.raw`(?:^|;|&&|\|\||\||\()\s*(?:nohup\s+)?${DISPATCH_WORD}\s+${sub}\b`);
}
