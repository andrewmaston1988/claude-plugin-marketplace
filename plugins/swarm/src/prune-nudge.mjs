// The Stop-hook reminder to prune: finished runs in the session's repo whose kept
// worktrees are still on disk. The engine names them only in the run's closing block,
// on the stdout a backgrounded dispatch never shows its session, so without this an
// agent with no standing instructions never learns a run is holding trees. It asks at
// every stop until the trees are gone, like grade-nudge: a reminder shown once is lost
// under a busy session. hooks/prune-nudge.mjs is the stdin/stdout wrapper.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSummary } from "./results.mjs";
import { runLiveness } from "./runlog.mjs";

const CLI = fileURLToPath(new URL("../scripts/swarm.mjs", import.meta.url));

// Kept trees still on disk for a FINISHED run — 0 for a live run or one that kept none.
// summary.json is read before liveness: most runs keep no tree.
function keptOnDisk(dir, heartbeatMs) {
  const kept = (readSummary(dir, { normalize: false })?.worktreesKept || []).filter((wt) => wt?.path && existsSync(wt.path));
  if (!kept.length) return 0;
  const live = runLiveness(dir, { heartbeatMs });
  return live.finishedMs == null && live.stoppedMs == null ? 0 : kept.length;
}

// Every finished run filed under `toplevel` with a kept tree on disk, whichever session
// launched it: a run whose session has ended would otherwise never be named again.
// No landed/unlanded guess — work lands by merge, cherry-pick, reset or the web UI, and
// whether a run's work has landed is the reader's call.
export function projectRunsHoldingWorktrees({ home, toplevel, heartbeatMs = 15_000 } = {}) {
  const out = [];
  if (!toplevel) return out;
  const root = join(home, "runs", toplevel.replace(/[\\/:]/g, "-"));
  let names = [];
  try { names = readdirSync(root); } catch { return out; }
  for (const name of names) {
    const dir = join(root, name);
    const kept = keptOnDisk(dir, heartbeatMs);
    if (kept) out.push({ dir, kept });
  }
  return out;
}

export function decidePruneNudge({ runs }) {
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
