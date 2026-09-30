// Finished runs whose kept worktrees are still on disk. The engine names them only in the
// closing block a backgrounded dispatch never shows, so the Stop hook asks at every stop,
// like grade-nudge — a reminder shown once is lost under a busy session.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { keptWorktreesOnDisk } from "./results.mjs";
import { enginePath, runsKeyFor } from "./config.mjs";

const CLI = enginePath();

// Every finished run filed under `toplevel` with a kept tree on disk, whichever session
// launched it: a run whose session has ended would otherwise never be named again.
// No landed/unlanded guess — work lands by merge, cherry-pick, reset or the web UI, and
// whether a run's work has landed is the reader's call.
export function projectRunsHoldingWorktrees({ home, toplevel, heartbeatMs = 15_000 } = {}) {
  const out = [];
  if (!toplevel) return out;
  const root = join(home, "runs", runsKeyFor(toplevel));
  let names = [];
  try { names = readdirSync(root); } catch { return out; }
  for (const name of names) {
    const dir = join(root, name);
    const kept = keptWorktreesOnDisk(dir, { heartbeatMs }).length;
    if (kept) out.push({ dir, kept });
  }
  return out;
}

// Pruning is the operator's call: a swarm leaf or autonomous session is never asked, and
// `swarm.pruneNudge: false` silences it like the sibling nudges.
export const inLeafOrAutonomous = (env) => env.SWARM_LEAF === "1" || Boolean(env.CORRELATION_ID);

export function decidePruneNudge({ runs, env = {}, config }) {
  if (inLeafOrAutonomous(env) || config?.swarm?.pruneNudge === false) return { block: false, reason: null };
  if (!runs?.length) return { block: false, reason: null };
  const one = runs.length === 1;
  const reason = [
    `${runs.length} finished swarm run${one ? "" : "s"} in this repo still ${one ? "holds" : "hold"} kept worktrees on disk.`,
    `Once a run's work has landed (merged, or deliberately discarded), prune it — dry-run first; it deletes the run's worktrees and branches, never its results:`,
    ...runs.map((r) => `  node ${CLI} prune ${r.dir} --dry-run   (${r.kept} tree${r.kept === 1 ? "" : "s"})`),
    `Leave any run whose work has not landed yet; this asks at every stop until its trees are gone.`,
  ].join("\n");
  return { block: true, reason };
}
