// `swarm prune` — destroy a finished run's kept worktrees and branches, refusing
// anything live, unlanded or dirty. Split out of swarm.mjs, which now just
// dispatches to it. The CLI-wide usage text stays in swarm.mjs and is passed in,
// so a bare `prune` still prints the same block as every other bad invocation.
import { join, resolve } from "node:path";
import { getConfig } from "../src/config.mjs";
import { runLiveness } from "../src/runlog.mjs";
import { writeSummary } from "../src/results.mjs";
import { plan as planPrune, execute as executePrune, formatPrune, blockers as pruneBlockers, repoOfWorktree, reposOfTrees, makeGit, reposFromManifest } from "../src/prune.mjs";
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
  const summaryFile = join(dir, "summary.json");
  const hadSummary = fs.existsSync(summaryFile);
  const summary = hadSummary ? JSON.parse(fs.readFileSync(summaryFile, "utf8")) : null;
  const worktreesKept = Array.isArray(summary?.worktreesKept) ? summary.worktreesKept : [];
  // Resolve each tree's own repo: one scalar attributed a second repo's tree to the
  // first and `git worktree remove` then silently failed against the wrong cwd.
  const keptWithRepo = worktreesKept.map((wt) => ({ ...wt, repo: wt.repo || repoOfWorktree(spawnSync, wt.path) }));
  const repos = [...new Set([...keptWithRepo.map((wt) => wt.repo), ...reposFromManifest(fs, dir), ...reposOfTrees(fs, dir, spawnSync)].filter(Boolean))];
  if (!repos.length) {
    err(`swarm: could not resolve the repo for ${dir} — no kept worktree survives and manifest.json has no cwd.`);
    return 1;
  }
  const git = makeGit(spawnSync);

  const { rows } = planPrune({ live: false, repos, resultsDir: dir, worktreesKept: keptWithRepo }, git, fs);
  if (!rows.length) {
    out(`swarm: ${dir} has no kept worktrees — nothing to prune.`);
    return 0;
  }
  out(formatPrune(rows, { dryRun }));
  const blocked = pruneBlockers(rows);
  if (!dryRun && blocked.length && !rest.includes("--discard-unlanded")) {
    for (const row of blocked) {
      const counts = [];
      if (row.unlanded > 0) counts.push(`${Number.isFinite(row.unlanded) ? row.unlanded : "unmeasurable"} unlanded`);
      if (row.dirty > 0) counts.push(`${Number.isFinite(row.dirty) ? row.dirty : "unmeasurable"} uncommitted`);
      err(`  ${row.path} ${row.branch ?? "(detached)"}: ${counts.join(", ")}`);
    }
    err("swarm: refusing — land or take this work first, or pass --discard-unlanded to destroy it");
    return 1;
  }
  if (!dryRun) {
    executePrune(rows, git, fs);
    // survivors: whatever wasn't just removed and wasn't already gone before we started
    if (hadSummary) writeSummary(dir, { ...summary, worktreesKept: worktreesKept.filter((wt) => fs.existsSync(wt.path)) });
  }
  return 0;
}
