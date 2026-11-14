// `swarm stop` — cooperative stop of a live run, and the recorded stop of a dead one.
// One command per module is the seam every sibling subcommand uses.
import { resolve, basename } from "node:path";
import { getConfig, enginePath } from "../src/config.mjs";
import { runLiveness, readRun, ALIVE_STATES } from "../src/runlog.mjs";
import { registeredForRun, makeGit, reposFromManifest } from "../src/prune.mjs";
import { formatKeptWorktrees, stopPath, appendRunLog, writeSummary, resultPath } from "../src/results.mjs";
import { addTokens, emptyTokens } from "../src/stream.mjs";
import { out, err } from "../src/ui.mjs";

// Dead engine: no live process to signal, so nothing is killed. The run-stop
// event + summary are the only record — read straight from disk (readRun),
// mirroring the shape runPlan itself writes so every reader treats the two
// the same way.
async function recordDeadEngineStop(dir, cfg) {
  appendRunLog(dir, { ts: new Date().toISOString(), event: "run-stop", reason: "dead-engine" });
  const run = readRun(dir);
  const tasks = run.tasks.map((t) => ({
    id: t.id,
    model: t.model,
    state: ALIVE_STATES.has(t.state) ? "failed:stopped" : t.state,
    durationMs: t.durationMs ?? null,
    tokens: t.tokens ?? null,
    resultPath: resultPath(dir, t.id),
  }));

  const fs = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  // Every repo the manifest named, not just the first: a run spanning two repos
  // leaves trees in both, and a dead engine is the only chance to record them.
  const git = makeGit(spawnSync);
  const worktreesKept = reposFromManifest(fs, dir)
    .filter((repo) => fs.existsSync(repo))
    .flatMap((repo) => registeredForRun(git, repo, dir, { cfg }).filter((r) => r.branch)
      .map((r) => ({ name: basename(r.path), branch: r.branch, path: r.path })));

  const summary = {
    started: run.startedMs ? new Date(run.startedMs).toISOString() : new Date().toISOString(),
    finished: new Date().toISOString(),
    stopped: true,
    stopReason: "dead-engine",
    tasks,
    blocked: run.tasks.filter((t) => t.state === "blocked").map((t) => t.id),
    worktreesKept,
    totalTokens: tasks.reduce((acc, t) => addTokens(acc, t.tokens || emptyTokens()), emptyTokens()),
  };
  writeSummary(dir, summary);
  const stopped = tasks.filter((t) => t.state === "failed:stopped").map((t) => t.id);
  out(`swarm: ${dir} — engine appears dead (stale heartbeat, no summary). Recorded run-stop; no process touched.`);
  out(`marked failed:stopped: ${stopped.length ? stopped.join(", ") : "(none — every leaf had already settled)"}`);
  if (worktreesKept.length) {
    // The printer names the engine to run next; it is swarm.mjs whoever called this.
    out(formatKeptWorktrees(worktreesKept, { resultsDir: dir, engine: enginePath() }));
  }
  return 0;
}

export async function cmdStop(rest) {
  const dir = resolve(rest[0]);
  const cfg = getConfig();
  const heartbeatMs = Math.max(50, (cfg.heartbeatSecs ?? 15) * 1000);
  const live = runLiveness(dir, { heartbeatMs });
  if (live.finishedMs != null) { err(`swarm: ${dir} already finished — nothing to stop.`); return 1; }
  if (live.stoppedMs != null) { err(`swarm: ${dir} already stopped — nothing to stop.`); return 1; }
  if (live.abortedMs != null) return await recordDeadEngineStop(dir, cfg);

  const { writeFileSync } = await import("node:fs");
  writeFileSync(stopPath(dir), "");
  const pollMs = heartbeatMs / 2;
  const deadline = Date.now() + heartbeatMs * 2;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const l = runLiveness(dir, { heartbeatMs });
    if (l.finishedMs != null || l.stoppedMs != null) {
      out(`swarm: ${dir} stopped.`);
      return 0;
    }
  }
  err(`swarm: engine did not respond within ${Math.round((heartbeatMs * 2) / 1000)}s — if it is wedged, end its process and run stop again to record it.`);
  return 1;
}
