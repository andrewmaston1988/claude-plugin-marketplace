#!/usr/bin/env node
/**
 * merge.mjs — Mechanical /merge pipeline runner (steps 0a-9).
 *
 * Every mutating git call runs in a throwaway worktree this run owns. The
 * shared checkout is touched once, at the end, by a fast-forward that refuses
 * rather than overwrites (land.mjs:landTarget).
 *
 * Usage:
 *   node merge.mjs --branches b1,b2,... --project-dir <path>
 *                  [--plans-dir <path>] [--session-slug <slug>]
 *                  [--dry-run] [--skip-smoke] [--skip-testing]
 *                  [--target-branch <branch>] [--parent <slug>] [--land-only]
 */
import { existsSync } from "node:fs";
import { join, basename, relative, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { connectUnified, close, rowGet, progressMark, planSetStatus } from "../../../src/db/index.mjs";
import { runGit, detectDefaultBranch, step0aRebase } from "./rebase.mjs";
import {
  branchSlug, step1IdentifyPlans, step2VerifyDone, step3UpdateStatus,
  step6MovePlans, step6bArchiveOrphanedPlans, dirInWorktree,
} from "./plan-files.mjs";
import { step0bProgress, step9Cleanup } from "./progress.mjs";
import { readSmokeCommand, step8Smoke } from "./smoke.mjs";
import { cleanupBranch, pushTarget, landTarget, parkSquash } from "./land.mjs";
import { createMergeWorktree } from "./worktree.mjs";
import {
  MergeAbort, step5SquashMerge, findOpenPR, verifyAlreadyIntegrated,
} from "./merge-branches.mjs";
import { featureWorktreePath } from "../../../src/worktree-paths.mjs";

// Step 5 and its helpers live in merge-branches.mjs (this file is over the
// file-size bar); re-exported so every existing call site keeps working.
export { MergeAbort, step5SquashMerge, findOpenPR, verifyAlreadyIntegrated };

const SELF = fileURLToPath(import.meta.url);

function logOut(msg) { process.stdout.write(msg + "\n"); }
function logErr(msg) { process.stderr.write(msg + "\n"); }
// Exit on a timer, per the plugin convention: a bare process.exit can drop a
// piped stderr on Windows, and these exits are the failure report.
function exitSoon(code) { setTimeout(() => process.exit(code), 150); }

// ── Path helpers ──────────────────────────────────────────────────────────────

function projectName(projectDir) { return basename(projectDir); }

function worktreePath(projectDir, slug) {
  return featureWorktreePath({ project: projectName(projectDir), projectRoot: projectDir, feature: slug });
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

// A squash whose worktree is about to be removed must stay reachable from a
// ref. Skip the park when the commit already lives in the target or origin.
function parkIfUnreachable(projectDir, wtPath, targetBranch, hasOrigin) {
  const head = runGit(["rev-parse", "HEAD"], wtPath, { check: false });
  if (head.code !== 0) return false;
  const sha = head.stdout.trim();
  const isAncestorOf = (ref) =>
    runGit(["merge-base", "--is-ancestor", sha, ref], projectDir, { check: false }).code === 0;
  if (isAncestorOf(targetBranch)) return false;
  if (hasOrigin) {
    const remote = runGit(["ls-remote", "origin", `refs/heads/${targetBranch}`], projectDir, { check: false });
    const remoteSha = (remote.stdout || "").trim().split(/\s/)[0];
    if (remoteSha && isAncestorOf(remoteSha)) return false;
  }
  return parkSquash(projectDir, targetBranch, sha);
}

// ── Step 7 — Commit the plan close in the merge worktree ─────────────────────

export async function step7CommitProject(wtDir, branches, { plansDir = null } = {}) {
  const resolvedPlansDir = plansDir || join(wtDir, "plans");
  if (!existsSync(resolvedPlansDir)) {
    logOut("[7] Nothing to commit in the merge worktree");
    return false;
  }
  // An external plansDir belongs to a different git repo: its move stays a
  // filesystem operation and is not committed here.
  if (!isInside(wtDir, resolvedPlansDir)) {
    logOut(`[7] plansDir '${resolvedPlansDir}' is outside the merge worktree — not committed here`);
    return false;
  }
  const rel = relative(wtDir, resolvedPlansDir);

  // Path-scoped by construction: only the plans directory is staged, and the
  // commit carries the same pathspec, so a foreign staged file cannot ride
  // along into the close commit.
  runGit(["add", "--", rel], wtDir);
  const status = runGit(["status", "--porcelain", "--", rel], wtDir).stdout;
  const tracked = status.split("\n").filter(l => l && !l.startsWith("??"));
  if (!tracked.length) {
    logOut("[7] Nothing to commit in the merge worktree");
    return false;
  }
  const title = `Close ${branches.map(branchSlug).join(", ")}: update plans, move to complete/`;
  runGit(["commit", "-m", title, "--", rel], wtDir);
  logOut(`[7] Committed: ${title}`);
  return true;
}

// ── Land-only resume: land a merge that already completed, touch nothing else ─

function landOnly(projectDir, targetBranch, args) {
  const candidates = [`origin/${targetBranch}`, `refs/merge/${targetBranch}`];
  let sha = null;
  let source = null;
  for (const ref of candidates) {
    const r = runGit(["rev-parse", "--verify", "--quiet", ref], projectDir, { check: false });
    if (r.code === 0) { sha = r.stdout.trim(); source = ref; break; }
  }
  if (!sha) {
    logErr(`BLOCKER: --land-only found neither ${candidates.join(" nor ")} in ${projectDir}`);
    return exitSoon(2);
  }
  logOut(`[land-only] landing ${sha.slice(0, 7)} (${source}) onto ${targetBranch}`);
  const res = landTarget(projectDir, targetBranch, sha, { log: logOut, err: logErr });
  if (!res.landed) {
    const paths = res.paths.length ? res.paths.join(", ") : "(unknown)";
    logOut(`[land-only] the shared checkout is behind; it was not moved (blocking path(s): ${paths})`);
    return exitSoon(0);
  }
  runGit(["update-ref", "-d", `refs/merge/${targetBranch}`], projectDir, { check: false });
  if (!args.skipSmoke) {
    const smokeCmd = readSmokeCommand(join(projectDir, "CLAUDE.md"));
    if (!step8Smoke(projectDir, smokeCmd)) return exitSoon(5);
  }
  logOut("merge.mjs — land complete");
  return exitSoon(0);
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    branches: null, projectDir: null, plansDir: null, sessionSlug: null,
    dryRun: false, skipSmoke: false, skipTesting: false, noRebase: false,
    landOnly: false, parent: null, targetBranch: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--branches":      args.branches = argv[++i]; break;
      case "--project-dir":   args.projectDir = argv[++i]; break;
      case "--plans-dir":     args.plansDir = argv[++i]; break;
      case "--session-slug":  args.sessionSlug = argv[++i]; break;
      case "--parent":        args.parent = argv[++i]; break;
      case "--target-branch": args.targetBranch = argv[++i]; break;
      case "--dry-run":       args.dryRun = true; break;
      case "--skip-smoke":    args.skipSmoke = true; break;
      case "--skip-testing":  args.skipTesting = true; break;
      case "--no-rebase":     args.noRebase = true; break;
      case "--land-only":     args.landOnly = true; break;
    }
  }
  return args;
}

// ── Main orchestration ────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.branches && !args.landOnly) { logErr("BLOCKER: --branches required"); return exitSoon(2); }

  const projectDir = args.projectDir ?? process.cwd();
  const project = projectName(projectDir);
  const now = new Date();
  const sessionSlug = args.sessionSlug
    ?? `merge_${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;

  const branches = (args.branches ?? "").split(",").map(b => b.trim()).filter(Boolean);
  if (!branches.length && !args.landOnly) { logErr("BLOCKER: no branches given"); return exitSoon(2); }

  // Resolve target branch: CLI > DB > auto-detected default
  let targetBranch = args.targetBranch;
  if (!targetBranch && branches.length) {
    const db0 = connectUnified();
    try {
      const row0 = rowGet(db0, project, branchSlug(branches[0]));
      const dbTarget = row0?.target_branch;
      if (dbTarget && !dbTarget.startsWith("autonomous/") && !branches.includes(dbTarget)) {
        targetBranch = dbTarget;
      }
    } catch { /* ignore */ } finally { close(db0); }
  }
  if (!targetBranch) {
    try { targetBranch = detectDefaultBranch(projectDir); }
    catch { targetBranch = "main"; }
  }

  logOut(`merge.mjs — project=${project} branches=${branches.join(",")}`);
  logOut(`  projectDir=${projectDir}`);
  logOut(`  targetBranch=${targetBranch}`);

  if (args.dryRun) {
    logOut("[dry-run] would execute Steps 0a-9; exiting without changes");
    return exitSoon(0);
  }
  if (args.landOnly) return landOnly(projectDir, targetBranch, args);

  // Only what a refusal report tells the operator the checkout stayed at; the
  // shared checkout is never reset now.
  const projectPreSha = runGit(["rev-parse", "HEAD"], projectDir).stdout.trim();
  const hasOrigin = runGit(["remote", "get-url", "origin"], projectDir, { check: false }).code === 0;

  const db = connectUnified();
  try {
    for (const branch of branches) {
      const slug = branchSlug(branch);
      const row = rowGet(db, project, slug);
      if (row && row.stage === "merge" && row.qa_pass == null) {
        logErr(`BLOCKER: row '${slug}' has stage=merge but qa_pass=NULL`);
        logErr(`  A row cannot reach merge without a test verdict.`);
        logErr(`  This indicates a bypass of the test→merge transition gate.`);
        close(db); return exitSoon(2);
      }
    }
  } catch (e) {
    logErr(`[warn] qa_pass pre-check failed: ${e.message}`);
  }

  // A parked squash is a merge waiting to be landed, not one to redo.
  const parkedRef = `refs/merge/${targetBranch}`;
  const parked = runGit(["rev-parse", "--verify", "--quiet", parkedRef], projectDir, { check: false });
  if (parked.code === 0) {
    const parkedSha = parked.stdout.trim();
    const inTarget = runGit(["merge-base", "--is-ancestor", parkedSha, targetBranch], projectDir, { check: false }).code === 0;
    if (!inTarget) {
      logErr(`BLOCKER: a parked merge exists at ${parkedRef} (${parkedSha.slice(0, 7)}) and is not in ${targetBranch}`);
      logErr(`  Land it first: node "${SELF}" --land-only --project-dir "${projectDir}" --target-branch "${targetBranch}"`);
      close(db); return exitSoon(2);
    }
    runGit(["update-ref", "-d", parkedRef], projectDir, { check: false });
    logOut(`[0] Cleared ${parkedRef} — that squash is already in ${targetBranch}`);
  }

  // Base the worktree on what origin holds: the final push must fast-forward
  // origin, and a base at a local tip behind origin would make every push fail.
  let baseRef = targetBranch;
  if (hasOrigin) {
    runGit(["fetch", "origin", targetBranch], projectDir, { check: false });
    if (runGit(["rev-parse", "--verify", "--quiet", `origin/${targetBranch}`], projectDir, { check: false }).code === 0) {
      baseRef = `origin/${targetBranch}`;
    }
  }
  const baseSha = runGit(["rev-parse", baseRef], projectDir).stdout.trim();

  let wt;
  try {
    wt = createMergeWorktree({ project, projectDir, sessionSlug, sha: baseSha });
  } catch (e) {
    logErr(`BLOCKER: ${e.message}`);
    close(db); return exitSoon(2);
  }
  logOut(`[0] Merge worktree: ${wt.path}`);

  // Progress marks are best-effort — never let them block the merge
  const mark = (idx, state) => { try { progressMark(db, sessionSlug, idx, state); } catch { /* ignore */ } };

  let exitCode = 0;
  try {
    step0bProgress(db, project, sessionSlug, args.parent);

    mark(0, "inprogress");
    if (args.noRebase) {
      logOut("[0a] --no-rebase: skipping rebase as requested by operator");
    } else {
      const rebaseOk = await step0aRebase(projectDir, branches, targetBranch);
      if (!rebaseOk) throw new MergeAbort(3, "step 0a (rebase)");
    }
    mark(0, "done");

    mark(1, "inprogress");
    const planFiles = step1IdentifyPlans(db, project, branches, { plansDir: args.plansDir });
    mark(1, "done");

    mark(2, "inprogress");
    const blockers = await step2VerifyDone(db, planFiles, projectDir, project, {
      skipTesting: args.skipTesting,
      targetBranch,
      wtPath: wt.path,
    });
    if (blockers.length) {
      for (const b of blockers) logErr(`BLOCKER: ${b}`);
      throw new MergeAbort(4, `step 2 (definition of done) — ${blockers.length} blocker(s)`);
    }
    mark(2, "done");

    // Step 4 (idx 4) — doc-impact removed (fragile LLM call, human judgment preferred)

    mark(5, "inprogress");
    await step5SquashMerge(db, project, projectDir, wt, branches, planFiles, targetBranch, {
      log: logOut, err: logErr,
    });
    mark(5, "done");

    // Steps 3 + 6 + 6b — plan writers, after the squash, in the merge worktree.
    // A staged plan edit before `git merge --squash` makes git refuse whenever
    // the branch touches its own plan.
    mark(3, "inprogress");
    await step3UpdateStatus(planFiles, projectDir, project, { wtPath: wt.path });
    mark(3, "done");

    mark(6, "inprogress");
    step6MovePlans(planFiles, { projectDir, wtPath: wt.path });
    for (const branch of branches) {
      try { planSetStatus(db, project, branchSlug(branch), "complete"); } catch { /* not in DB */ }
    }
    mark(6, "done");

    const plansDirSource = args.plansDir
      ?? dirname(Object.values(planFiles).find(Boolean) || join(projectDir, "plans"));
    const plansDirWt = dirInWorktree(projectDir, wt.path, plansDirSource);
    step6bArchiveOrphanedPlans(db, project, { plansDir: plansDirSource, projectDir, wtPath: wt.path });

    mark(7, "inprogress");
    await step7CommitProject(wt.path, branches, { plansDir: plansDirWt });

    // Step 7b — push, park, then land. The shared checkout is untouched until
    // the land, and a failed push leaves it untouched.
    const headSha = runGit(["rev-parse", "HEAD"], wt.path).stdout.trim();
    if (hasOrigin) {
      if (!pushTarget(wt.path, targetBranch, { sha: headSha, log: logOut, err: logErr })) {
        parkSquash(projectDir, targetBranch, headSha);
        logErr(`[7b] Parked ${headSha.slice(0, 7)} at ${parkedRef} — shared checkout untouched`);
        throw new MergeAbort(7, "step 7b (push)");
      }
    } else {
      parkSquash(projectDir, targetBranch, headSha);
      logOut(`[7b] No origin — parked ${headSha.slice(0, 7)} at ${parkedRef}`);
    }

    const land = landTarget(projectDir, targetBranch, headSha, { log: logOut, err: logErr });
    if (land.landed) {
      runGit(["update-ref", "-d", parkedRef], projectDir, { check: false });
    } else {
      // A refused land is a completed merge: the work is on origin (or parked),
      // and someone else is mid-edit in the shared checkout.
      const paths = land.paths.length ? land.paths.join(", ") : "(unknown)";
      logOut(`[land] the shared checkout is behind; it was not moved (blocking path(s): ${paths})`);
      logOut(`[land] it stayed at ${projectPreSha.slice(0, 7)}; land later with:`);
      logOut(`  node "${SELF}" --land-only --project-dir "${projectDir}" --target-branch "${targetBranch}"`);
      logOut("[land] smoke skipped — the checkout does not hold the merge");
    }
    mark(7, "done");

    // Cleanup after the land, so a later failure has not already deleted the branch.
    for (const branch of branches) {
      await cleanupBranch(projectDir, branch, worktreePath(projectDir, branchSlug(branch)), { log: logOut, err: logErr });
    }

    // Step 8 — smoke tests the real checkout, so it runs only once the merge is there.
    if (land.landed && !args.skipSmoke) {
      mark(8, "inprogress");
      const smokeCmd = readSmokeCommand(join(projectDir, "CLAUDE.md"));
      if (!step8Smoke(projectDir, smokeCmd)) throw new MergeAbort(5, "step 8 (smoke check)");
      mark(8, "done");
    }

    logOut("merge.mjs — complete");
  } catch (e) {
    if (e instanceof MergeAbort) {
      logErr(`[merge] aborted at ${e.message}`);
      exitCode = e.exitCode;
    } else {
      logErr(`[merge] Unexpected error: ${e.message ?? e}`);
      exitCode = 6;
    }
  } finally {
    // Rollback becomes worktree removal. The shared checkout is never reset.
    if (wt) {
      if (parkIfUnreachable(projectDir, wt.path, targetBranch, hasOrigin)) {
        logErr(`[merge] parked the merge worktree's HEAD at ${parkedRef} before removing it`);
      }
      wt.remove();
    }
    try { step9Cleanup(db, sessionSlug); } catch { /* ignore */ }
    close(db);
  }

  exitSoon(exitCode);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    logErr(`[fatal] ${e.message ?? e}`);
    exitSoon(6);
  });
}
