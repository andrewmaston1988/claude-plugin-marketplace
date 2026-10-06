// `swarm run` and its engine-claim preflight — split out of scripts/swarm.mjs,
// which now just dispatches to it, the same shape as cmd-status.mjs and
// cmd-grade.mjs. The preflight lives here with the run: refusing a second engine
// on a resultsDir and claiming it are one concern, and `ask` imports the
// preflight from here because it takes the same claim.
//
// The argv→ref prelude (`parseArgsFlag`, `resolveManifestRef`, `usageHeadroom`)
// stays in swarm.mjs, shared with `validate` and `models`, so it is injected at
// the dispatch site rather than duplicated here.
import { join } from "node:path";
import { getConfig, swarmHome, enginePath } from "./config.mjs";
import { costOfFor } from "./run-cost.mjs";
import { loadManifest } from "./manifest.mjs";
import { modelRoster } from "./roster.mjs";
import { defaultProviderRegistry } from "./default-providers.mjs";
import { runPlan, makeDefaultIo } from "./scheduler.mjs";
import { loadCorpus, estimateRun } from "./estimate.mjs";
import { formatClosing, readResult, writeDigestMd, readHeartbeat } from "./results.mjs";
import { runLiveness } from "./runlog.mjs";
import { claimEngine, lockRefusal } from "./engine-lock.mjs";
import { unvalidatedRefusal } from "./validated.mjs";
import { out, err } from "./ui.mjs";

// A second engine on the same resultsDir resumes each leaf's recorded session
// alongside the first — two processes driving one Claude session. Only a real
// heartbeat file makes a dir "live"; a brand-new or never-run dir has none, and
// runLiveness alone can't tell that apart from a genuinely alive engine.
export function refuseLiveEngine(dir, cfg, verb) {
  const hb = readHeartbeat(dir);
  if (!hb) return false;
  const heartbeatMs = Math.max(50, (cfg.heartbeatSecs ?? 15) * 1000);
  const live = runLiveness(dir, { heartbeatMs });
  if (live.finishedMs == null && live.stoppedMs == null && live.abortedMs == null) {
    err(lockRefusal(dir, hb.pid, verb));
    return true;
  }
  return false;
}

export async function cmdRun(rest, { parseArgsFlag, resolveManifestRef, usageHeadroom }) {
  const cfg = getConfig();
  const force = rest.includes("--force");
  const args = parseArgsFlag(rest);
  const ref = resolveManifestRef(rest[0]);
  const fromRegistry = ref.source !== "path";
  const plan = loadManifest(ref.path, cfg, process.cwd(), { args, fromRegistry, headroom: await usageHeadroom(cfg), cache: modelRoster({ config: cfg, env: process.env, registry: defaultProviderRegistry() }).models, ...(fromRegistry && { ref: rest[0] }) });
  // Shared by the end-of-run status and the scheduler's single-shot cost warn.
  const { createNotifier } = await import("./notify.mjs");
  const notify = createNotifier({ notifyCmd: cfg.notifyCmd });
  // Engine-side, so it holds on hosts the hook gates never reach. Both refusals below
  // are synchronous reads that return before the claim, which is what keeps a refused
  // run from creating its run dir: only `claimEngine` may do that.
  if (refuseLiveEngine(plan.resultsDir, cfg, "re-running")) return 1;
  const refusal = unvalidatedRefusal(plan, args, rest[0]);
  if (refusal) {
    err(refusal);
    return 1;
  }
  // The claim owns everything expensive that follows: the estimate's corpus walk, the
  // preflights and runPlan's startup all sit inside it, and the heartbeat is written at
  // the very end of that startup — exactly the window a second `swarm run` used to slip
  // into. Nothing awaited separates the checks above from here, so no race can land in
  // between them.
  const claimed = claimEngine(plan.resultsDir, { heartbeatMs: Math.max(50, (cfg.heartbeatSecs ?? 15) * 1000) });
  if (!claimed.ok) {
    err(lockRefusal(plan.resultsDir, claimed.pid, "re-running"));
    return 1;
  }

  plan.estimate = estimateRun(plan.tasks, plan.digest, loadCorpus(join(swarmHome(), "runs")));

  // Ground truth, up front: a session that has to reconstruct the run directory
  // gets it wrong (the default is <stem>-1, and --force reuses it rather than
  // minting <stem>-2). Print the path and the exact watch command so the string
  // handed to the operator is copied, never remembered.
  out(`resultsDir: ${plan.resultsDir}`);
  out(`watch:      node ${enginePath()} status ${plan.resultsDir} --watch`);

  const io = makeDefaultIo();
  io.notify = (status) => { notify(status); };
  const r = await runPlan(plan, cfg, io, { force });

  // A cache replay IS a success: the results are valid and the resume workflow
  // depends on it, so the exit code stays 0 and the caching is untouched. What must
  // change is the WORDING — "finished clean" plus a bare digest path let a session
  // skim the tail and report a no-op as a completed fresh round. The digest it
  // points at predates this invocation; say so.
  const live = r.summary.tasks.filter((t) => t.id !== "__digest");
  const replayed = live.length > 0 && live.every((t) => t.state === "skipped");
  if (replayed) {
    out(`NOTHING RE-EXECUTED — all ${live.length} task(s) replayed from cache in ${plan.resultsDir}.`);
    out("The digest below is from the PREVIOUS run, not this invocation — nothing about it is new.");
    out("To re-execute this manifest: --force (same resultsDir; results are overwritten).");
  }

  // Grading is opt-in (grading.enabled): off, nothing asks and the store is never
  // read; `grade`/`perf` still work when called. On, the closing block and the
  // digest footer share one rule — the run still has no store rows.
  let gradeable;
  if (cfg.grading?.enabled === true) {
    const { runGradeable } = await import("./grade-nudge.mjs");
    const { readRows, scoresPath, gradedRunKeys } = await import("./scores.mjs");
    gradeable = runGradeable(plan.resultsDir, { cfg, graded: gradedRunKeys(readRows(scoresPath())) });
  }
  // Rewritten from the digest leaf's stored output, never the file on disk, so a
  // replay carries one footer, never two; a graded replay drops it.
  if (r.digestPath) {
    const body = readResult(plan.resultsDir, "__digest")?.output;
    if (body) writeDigestMd(plan.resultsDir, body, gradeable);
  }

  out(formatClosing({
    digestPath: r.digestPath,
    reportPath: r.reportPath,
    reportMissing: r.reportMissing,
    pagesError: r.pagesError,
    digestFailed: r.digestFailed,
    summaryPath: r.summaryPath,
    totalTokens: r.summary.totalTokens,
    worktreesKept: r.worktreesKept,
    truncations: r.summary.truncations,
    refutations: r.summary.refutations,
    coverageGaps: r.summary.coverageGaps,
    estimate: plan.estimate,
    resultsDir: plan.resultsDir,
    engine: enginePath(),
    gradeable,
    memoryParks: r.memoryParks,
    costText: costOfFor(cfg)(r.summary.tasks),
  }));

  const bad = r.summary.tasks.filter((t) => !["ok", "skipped"].includes(t.state) && t.id !== "__digest");
  await notify(
    bad.length ? `swarm run finished with ${bad.length} failed/blocked`
      : replayed ? "swarm run finished — cache replay, nothing re-executed"
        : "swarm run finished clean",
    { digest: r.digestPath || "", ...(r.reportPath && { report: r.reportPath }), summary: r.summaryPath || "" },
  );
  if (bad.length) {
    out(`FAILED tasks: ${bad.map((t) => `${t.id} [${t.state}]`).join(", ")}`);
    const quotaBad = bad.filter((t) => t.state === "quota");
    if (quotaBad.length) {
      const resets = quotaBad.map((t) => readResult(plan.resultsDir, t.id)?.quotaResetsAt).find(Boolean);
      // quotaResetsAt is either a real ISO instant (parseQuotaReset's epoch path) or a
      // human-text fragment like "3pm" — format the former, pass the latter through.
      const { formatResetTime } = await import("./usage.mjs");
      const shown = resets ? (formatResetTime(resets) ?? resets) : null;
      out(`quota: ${quotaBad.length} leaf(s) blocked by Anthropic usage limits${shown ? ` — re-run after ${shown}` : ""}`);
    }
    out("resume: re-run the same command — ok results are skipped, failed/blocked work re-executes.");
    return 1;
  }
  // A digest failure alone never blocks result availability — the run is done;
  // the session falls back to summary.json + selective raw reads.
  if (r.summary.stopped) return 1;
  return 0;
}
