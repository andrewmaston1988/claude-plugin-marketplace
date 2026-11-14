// `swarm prune` — destroy a finished run's kept worktrees and branches, refusing
// anything live, unlanded or dirty. Split out of swarm.mjs, which now just
// dispatches to it. The CLI-wide usage text stays in swarm.mjs and is passed in,
// so a bare `prune` still prints the same block as every other bad invocation.
import { join, resolve } from "node:path";
import { getConfig } from "../src/config.mjs";
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

  const { rows } = planPrune(run, git, fs, { cfg, extraBases, measureBytes: true });
  if (!rows.length) {
    out(`swarm: ${dir} has no kept worktrees — nothing to prune.`);
    return 0;
  }
  // The guard decides the run BEFORE the report describes it: a refused call must
  // never print "freed", or the loudest line on screen would claim a destruction
  // that did not happen.
  const blocked = pruneBlockers(rows);
  if (!dryRun && blocked.length && !rest.includes("--discard-unlanded")) {
    for (const row of blocked) {
      err(`  ${row.path} ${row.branch ?? "(detached)"}: ${workCounts(row).join(", ")}`);
    }
    err("swarm: refusing — land or take this work first, or pass --discard-unlanded to destroy it");
    return 1;
  }
  out(formatPrune(rows, { dryRun }));
  if (!dryRun) {
    executePrune(rows, git, fs, { resultsDir: dir, cfg });
    // survivors: whatever wasn't just removed and wasn't already gone before we started
    if (hadSummary) writeSummary(dir, { ...summary, worktreesKept: kept.filter((wt) => fs.existsSync(wt.path)) });
  }
  return 0;
}
