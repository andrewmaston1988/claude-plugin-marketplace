// `swarm prune` — delete a finished run's kept worktrees and branches at once, keeping
// and naming every row that still holds unlanded or uncommitted work. A live run is
// refused. Split out of swarm.mjs, which now just dispatches to it. The CLI-wide usage
// text stays in swarm.mjs and is passed in, so a bare `prune` still prints the same
// block as every other bad invocation.
import { join, resolve } from "node:path";
import { getConfig, swarmHome } from "../src/config.mjs";
import { readTaken } from "../src/taken.mjs";
import { runLiveness } from "../src/runlog.mjs";
import { writeSummary } from "../src/results.mjs";
import { plan as planPrune, execute as executePrune, formatPrune, workCounts, blockers as pruneBlockers, makeGit, runForPrune, checkoutBase } from "../src/prune.mjs";
import { out, err } from "../src/ui.mjs";

export async function cmdPrune(rest, { usage }) {
  // The dir is the first non-flag arg, so `prune --dry-run <dir>` and
  // `prune <dir> --dry-run` mean the same thing.
  const target = rest.find((a) => !a.startsWith("--"));
  if (!target) { err(usage); return 1; }
  const dir = resolve(target);
  const dryRun = rest.includes("--dry-run");
  const fs = await import("node:fs");
  // runLiveness reads "no run.log, no summary, no heartbeat" as a live run with
  // nothing written yet — for prune that is a typo'd path, not something to refuse.
  if (!fs.existsSync(join(dir, "run.log"))) { err(`swarm: no run at ${dir} (no run.log)`); return 1; }
  const cfg = getConfig();
  const heartbeatMs = Math.max(50, (cfg.heartbeatSecs ?? 15) * 1000);
  const live = runLiveness(dir, { heartbeatMs });
  if (live.finishedMs == null && live.stoppedMs == null && live.abortedMs == null) {
    err(`swarm: ${dir} live — swarm stop it first`);
    return 1;
  }

  const { spawnSync } = await import("node:child_process");
  // A killed run wrote no summary.json; prune must tolerate that and never invent one.
  const built = runForPrune(dir, { fs, spawnSync });
  if (built.error) { err(`swarm: ${built.error}`); return 1; }
  const { run, summary, hadSummary } = built;
  const kept = Array.isArray(summary?.worktreesKept) ? summary.worktreesKept : [];
  const git = makeGit(spawnSync);
  const prefix = cfg.worktreeBranchPrefix || "swarm/";
  // The invoking checkout's HEAD is the one base a port made in a separate worktree
  // leaves behind — but only when it is this repo on a named non-swarm branch.
  const extraBases = [checkoutBase(git, process.cwd(), run.repos, prefix)].filter(Boolean);

  // The taken log lives per repo and a run may span several: merge what each one holds.
  // A repo with no log contributes nothing, and prune behaves exactly as before.
  const taken = new Map();
  for (const toplevel of run.repos) {
    for (const [key, record] of readTaken({ home: swarmHome(), toplevel, fs })) taken.set(key, record);
  }

  // The report describes every row, so it never stops at a blocker or a clock.
  const { rows } = planPrune(run, git, fs, { cfg, extraBases, measureBytes: true, stopAtBlocker: false, deadline: Infinity, taken });
  if (!rows.length) {
    out(`swarm: ${dir} has no kept worktrees or branches — nothing to prune.`);
    return 0;
  }
  // Partial prune: a blocked row is kept and never touched, and never stops the clean ones.
  // A directory that is no longer a worktree and holds anything at all is held back before
  // `--discard-unlanded` is even consulted: git cannot say what those bytes are, so the
  // flag that destroys unlanded work has nothing to claim about them.
  const discard = rest.includes("--discard-unlanded");
  const heldBack = rows.filter((row) => row.unlinked && row.entries > 0);
  const prunable = rows.filter((row) => !heldBack.includes(row));
  const blocked = pruneBlockers(prunable);
  const go = discard ? prunable : prunable.filter((row) => !blocked.includes(row));
  const stay = [...(discard ? [] : blocked), ...heldBack];

  if (dryRun) {
    if (go.length) out(formatPrune(go, { dryRun: true }));
    const clearing = go.filter((row) => row.unlinked);
    if (clearing.length) {
      out(`swarm: would clear ${dirCount(clearing.length)} left behind by a lost worktree link:`);
      for (const row of clearing) out(`  ${row.path}`);
    }
    if (stay.length) {
      out(`swarm: would keep ${rowCount(stay.length)} that still ${stay.length === 1 ? "holds" : "hold"} work:`);
      for (const row of stay) out(`  ${rowLabel(row)}: ${keptDetail(row)}`);
    }
    return 0;
  }

  const { failed } = executePrune(go, git, fs, { resultsDir: dir, cfg });
  const failure = new Map(failed.map(({ row, reason }) => [row, reason]));
  const removed = [];
  const refused = [];
  for (const row of go) {
    if (!failure.has(row) && gone(row, git, fs)) removed.push(row);
    else refused.push({ row, reason: failure.get(row) ?? null });
  }
  // survivors: whatever wasn't just removed and wasn't already gone before we started
  if (hadSummary) writeSummary(dir, { ...summary, worktreesKept: kept.filter((wt) => fs.existsSync(wt.path)) });
  // The report follows execute: a removal git refused is kept, never printed as freed.
  if (removed.length) out(formatPrune(removed));
  for (const row of stay) err(`  ${rowLabel(row)}: ${keptDetail(row)}`);
  for (const { row, reason } of refused) {
    err(`  ${rowLabel(row)}: ${workCounts(row).join(", ") || firstLine(reason) || "still present"}`);
  }
  // Two unrelated causes, two remedies: `stay` rows hold work the operator must land or
  // take, and `--discard-unlanded` is the word that overrides that. A `refused` row is one
  // git itself would not remove (a locked worktree, say) — retrying with the flag re-runs
  // the same removal, so it is never offered there.
  const discardable = stay.filter((row) => !heldBack.includes(row));
  if (discardable.length) {
    err(`swarm: kept ${rowCount(discardable.length)} that still ${discardable.length === 1 ? "holds" : "hold"} work — land or take it and prune again, or pass --discard-unlanded to destroy it`);
  }
  // Nothing a flag can do about these: prune will not delete bytes it cannot account for.
  if (heldBack.length) {
    err(`swarm: ${rowCount(heldBack.length)} kept with a leftover directory prune will not clear — inspect and remove by hand: ${heldBack.map((row) => row.path).join(", ")}`);
  }
  if (refused.length) {
    err(`swarm: kept ${rowCount(refused.length)} that git refused to remove — clear what git names above and prune again`);
  }
  return stay.length || refused.length ? 1 : 0;
}

const rowLabel = (row) => `${row.path ?? "(no tree)"} ${row.branch ?? "(detached)"}`;
// A kept row's taken reason is the actionable half: the count says how much, the reason
// says why it stays (the branch it was ported into, and why that is not proved landed).
const keptDetail = (row) => [
  workCounts(row).join(", "),
  row.unlinked && row.entries > 0 ? `unlinked directory ${row.path} (${dirCount(row.entries, "entry", "entries")})` : null,
  row.taken,
].filter(Boolean).join("; ") || "still present";
const rowCount = (n) => `${n} row${n === 1 ? "" : "s"}`;
const dirCount = (n, word = "directory", plural = `${word}s`) => `${n} ${n === 1 ? word : plural}`;
const firstLine = (text) => (text || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "";

// A row is gone when its tree left the disk, or a branch-only row's ref no longer resolves.
function gone(row, git, fs) {
  if (row.path != null) return !fs.existsSync(row.path);
  if (!fs.existsSync(row.repo)) return false;
  return git(["rev-parse", "--verify", `refs/heads/${row.branch}`], row.repo).status !== 0;
}
