// Finished runs whose kept worktrees are still on disk, scoped to the session that
// dispatched them. The engine names them only in the closing block a backgrounded
// dispatch never shows, so the nudge hook says it per turn — one line, once per
// run — and the per-run list lives in `swarm status --mine`, a command's output the
// terminal collapses.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keptWorktreesOnDisk } from "./results.mjs";
import { enginePath, runsKeyFor } from "./config.mjs";
import { lastRunStart } from "./grade-nudge.mjs";

const CLI = enginePath();

// The marker naming a run as already announced to ONE launcher. A resume appends a
// second run-start, so the new owner has a new launcher and is told once in turn.
const PRUNE_MARKER = "prune-nudged";
export const pruneMarkerPath = (dir) => join(dir, PRUNE_MARKER);

export function writePruneMarker(dir, sessionId) {
  writeFileSync(pruneMarkerPath(dir), sessionId);
}

function alreadyNudged(dir, sessionId) {
  try { return readFileSync(pruneMarkerPath(dir), "utf8") === sessionId; } catch { return false; }
}

// One repo's runs — the hook's toplevel and `status --mine`'s must agree, so this is
// not grade-nudge's all-encodings walk. A run belongs to the session stamped on its
// LATEST run-start (`launcher`), the same rule grade-nudge reads.
// Cheap predicates first: kept trees on disk and the marker are judged before any
// run.log is read.
// `skipNudged` is the hook's path alone: it drops the runs whose marker already names
// this session, so the line is said once. The listing must NOT skip them, or it would
// hide the very run the line points at.
export function projectRunsHoldingWorktrees({ home, toplevel, sessionId, skipNudged = false, heartbeatMs = 15_000 } = {}) {
  const out = { mine: [], others: 0 };
  if (!toplevel) return out;
  const root = join(home, "runs", runsKeyFor(toplevel));
  let names = [];
  try { names = readdirSync(root); } catch { return out; }
  for (const name of names) {
    const dir = join(root, name);
    const kept = keptWorktreesOnDisk(dir, { heartbeatMs }).length;
    if (!kept) continue;
    if (skipNudged && sessionId && alreadyNudged(dir, sessionId)) continue;
    let text;
    try { text = readFileSync(join(dir, "run.log"), "utf8"); } catch { continue; }
    const launcher = lastRunStart(text)?.launcher;
    if (sessionId && launcher === sessionId) out.mine.push({ dir, kept });
    // A run dispatched outside any session has no owner: it is never nudged, and it
    // is not another session's backlog either.
    else if (typeof launcher === "string" && launcher) out.others += kept;
  }
  return out;
}

// Pruning a finished run is clean-up, not a question — the model takes what it still
// needs and prunes. A leaf or autonomous session is never asked, and
// `swarm.pruneNudge: false` silences it like the sibling nudges.
export const inLeafOrAutonomous = (env) => env.SWARM_LEAF === "1" || Boolean(env.CORRELATION_ID);

// Exactly one line: the nudge hook prints it once per run, and the per-run detail it
// points at lives in the listing `node <cli> status --mine` prints.
export function pruneReason({ worktrees, others }) {
  const mine = `${worktrees} worktree${worktrees === 1 ? "" : "s"} from runs in this session`;
  const andOthers = others > 0 ? ` (and ${others} other${others === 1 ? "" : "s"})` : "";
  return `${mine}${andOthers} — run \`node ${CLI} status --mine\`, take what you still need, then prune each run once its work has landed or been taken — do not ask the operator.`;
}

export function decidePruneNudge({ mine = [], others = 0, env = {}, config } = {}) {
  if (inLeafOrAutonomous(env) || config?.swarm?.pruneNudge === false) return { block: false, reason: null };
  // Another session's trees are counted but never a reason to block: there is
  // nothing here for this session to act on.
  if (!mine?.length) return { block: false, reason: null };
  return { block: true, reason: pruneReason({ worktrees: mine.reduce((n, r) => n + r.kept, 0), others }) };
}

// What `swarm status --mine` prints. Read-only — it prunes nothing — and it lists every
// run this session owns while its trees remain, including the ones the hook has already
// named: the marker gates the hook's line, never this listing.
export function formatMineStatus({ mine = [], others = 0, cli = CLI } = {}) {
  if (!mine.length) return ["swarm status --mine: no finished run this session dispatched is holding kept worktrees."];
  const trees = mine.reduce((n, r) => n + r.kept, 0);
  const runs = `${mine.length} finished run${mine.length === 1 ? "" : "s"} this session dispatched`;
  const lines = [
    `swarm status --mine: ${runs} ${mine.length === 1 ? "holds" : "hold"} ${trees} kept worktree${trees === 1 ? "" : "s"}.`,
    ...mine.map((r) => `  node ${cli} prune ${r.dir} --dry-run   (${r.kept} tree${r.kept === 1 ? "" : "s"})`),
  ];
  if (others > 0) lines.push(`Other sessions' runs hold ${others} more (not this session's to prune).`);
  lines.push("Take what you still need, then prune each run once its work has landed or been taken — do not ask the operator; `prune` deletes a run's worktrees and branches, never its results.");
  return lines;
}
