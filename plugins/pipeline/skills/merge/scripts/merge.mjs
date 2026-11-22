#!/usr/bin/env node
/**
 * merge.mjs — Mechanical /merge pipeline runner.
 *
 * Port of CLAUDE/scripts/merge.py to Node.js ESM. Steps 0a-9:
 * rebase, verify DoD, squash merge, plan archival, project commit, smoke check.
 *
 * Key differences from merge.py:
 *   - No --claude-base: plans live at --plans-dir (default: <project-dir>/plans/)
 *   - Plan file path is read from the pipeline DB row (stored at queue time)
 *   - "Commit CLAUDE repo" step commits plan moves in the project repo only
 *   - All pipeline-db calls via ESM imports, no python pipeline_cli subprocess
 *
 * Usage:
 *   node merge.mjs --branches b1,b2,... --project-dir <path>
 *                  [--plans-dir <path>] [--session-slug <slug>]
 *                  [--dry-run] [--skip-smoke] [--skip-testing]
 *                  [--target-branch <branch>] [--parent <slug>]
 */
import { existsSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import {
  connectUnified, close, listEnabledProjects,
  rowGet,
  progressMark,
  planSetStatus,
} from "../../../src/db/index.mjs";
import {
  runGit,
  gitAddWithRetry,
  gitCommitWithRetry,
  detectDefaultBranch,
  step0aRebase,
} from "./rebase.mjs";
import {
  branchSlug,
  step1IdentifyPlans,
  step2VerifyDone,
  step3UpdateStatus,
  step6MovePlans,
  step6bArchiveOrphanedPlans,
} from "./plan-files.mjs";
import { step0bProgress, step9Cleanup } from "./progress.mjs";
import { readSmokeCommand, step8Smoke } from "./smoke.mjs";
import { pushTarget } from "./land.mjs";
import { resolveProjectFromPath } from "../../../src/project-from-path.mjs";
import { logOut, logErr, step5SquashMerge } from "./merge-step5.mjs";

export { findOpenPR, verifyAlreadyIntegrated, step5SquashMerge } from "./merge-step5.mjs";

// ── Subprocess helpers ────────────────────────────────────────────────────────
// Exit on a timer, per the plugin convention: a bare process.exit can drop a
// piped stderr on Windows, and these exits are the failure report.
function exitSoon(code) { setTimeout(() => process.exit(code), 150); }

// Steps that fail on their own terms (rebase, DoD gate, smoke) abort with their
// own exit code. Thrown, never `return`ed: a return inside the try skips the
// trailing process.exit, the process falls off the end at 0, and a caller reads
// the rolled-back merge as landed.
class MergeAbort extends Error {
  constructor(code, message) {
    super(message);
    this.exitCode = code;
  }
}

// ── Step 0a — Rebase ──────────────────────────────────────────────────────────
// Delegated to rebase.mjs:step0aRebase (imported at top of file).

// ── Step 0b — Progress file ───────────────────────────────────────────────────
// Delegated to progress.mjs:step0bProgress.

// ── Step 1 — Identify plan files ─────────────────────────────────────────────
// Delegated to plan-files.mjs:step1IdentifyPlans.

// ── Step 2 — Definition of done ──────────────────────────────────────────────
// Delegated to plan-files.mjs:step2VerifyDone.

// ── Step 3 — Update plan Current Status ──────────────────────────────────────
// Delegated to plan-files.mjs:step3UpdateStatus.

// ── Step 5 — Squash merge each branch ────────────────────────────────────────
// Delegated to merge-step5.mjs:step5SquashMerge.

// ── Step 7 — Commit project ───────────────────────────────────────────────────
// (Renamed from "Commit CLAUDE repo" — commits plan file moves in project repo)

export async function step7CommitProject(projectDir, branches, { plansDir = null } = {}) {
  // Stage the plans directory — use plansDir if provided, else default to <projectDir>/plans
  const resolvedPlansDir = plansDir || join(projectDir, "plans");
  if (existsSync(resolvedPlansDir)) {
    // Only stage plansDir when it lives inside projectDir. An external plansDir
    // belongs to a different git repo; staging it from here fails and is not our job.
    const rel = relative(projectDir, resolvedPlansDir);
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      await gitAddWithRetry(projectDir, resolvedPlansDir);
    } else {
      logOut(`[7] plansDir '${resolvedPlansDir}' is outside projectDir — skipping git add in project repo`);
    }
  }

  // Filter ?? (untracked) lines before deciding whether to commit
  const status = runGit(["status", "--porcelain"], projectDir).stdout;
  const tracked = status.split("\n").filter(l => l && !l.startsWith("??"));
  if (!tracked.length) {
    logOut("[7] Nothing to commit in project repo");
    return false;
  }

  const title = `Close ${branches.map(branchSlug).join(", ")}: update plans, move to complete/`;
  await gitCommitWithRetry(projectDir, "-m", title);
  logOut(`[7] Committed: ${title}`);
  return true;
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    branches: null,
    projectDir: null,
    plansDir: null,
    sessionSlug: null,
    dryRun: false,
    skipSmoke: false,
    skipTesting: false,
    noRebase: false,
    parent: null,
    targetBranch: null,
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
    }
  }
  return args;
}

// ── Main orchestration ────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.branches) { logErr("BLOCKER: --branches required"); return exitSoon(2); }

  const now = new Date();
  const sessionSlug = args.sessionSlug
    ?? `merge_${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;

  const branches = args.branches.split(",").map(b => b.trim()).filter(Boolean);
  if (!branches.length) { logErr("BLOCKER: no branches given"); return exitSoon(2); }

  const registry = connectUnified();
  let project;
  let projectRoot;
  let targetBranch = args.targetBranch;
  try {
    const rows = Array.from(listEnabledProjects(registry), ([name, root_path]) => ({ name, root_path }));
    const resolved = resolveProjectFromPath(args.projectDir ?? process.cwd(), { rows });
    project = resolved.project;
    projectRoot = args.projectDir ?? resolved.projectRoot;

    // Resolve target branch: CLI > DB > auto-detected default.
    if (!targetBranch) {
      try {
        const dbTarget = rowGet(registry, project, branchSlug(branches[0]))?.target_branch;
        if (dbTarget && !dbTarget.startsWith("autonomous/") && !branches.includes(dbTarget)) {
          targetBranch = dbTarget;
        }
      } catch { /* ignore */ }
    }
  } finally {
    close(registry);
  }
  if (!targetBranch) {
    try { targetBranch = detectDefaultBranch(projectRoot); }
    catch { targetBranch = "main"; }
  }

  logOut(`merge.mjs — project=${project} branches=${branches.join(",")}`);
  logOut(`  projectDir=${projectRoot}`);
  logOut(`  targetBranch=${targetBranch}`);

  if (args.dryRun) {
    logOut("[dry-run] would execute Steps 0a-9; exiting without changes");
    return exitSoon(0);
  }

  // Pre-check: refuse if project has staged or unstaged changes
  const staged = runGit(["diff", "--cached", "--name-only"], projectRoot, { check: false }).stdout.trim();
  if (staged) {
    logErr(`BLOCKER: project has staged changes — abort to avoid mixing state`);
    logErr(`  staged files:\n${staged}`);
    logErr("  Resolve manually (commit or `git restore --staged <files>`) and retry.");
    return exitSoon(2);
  }
  const unstaged = runGit(["diff", "--name-only"], projectRoot, { check: false }).stdout.trim();
  if (unstaged) {
    logErr(`BLOCKER: project has unstaged changes — abort to protect working tree`);
    logErr(`  unstaged files:\n${unstaged}`);
    logErr("  Stash or commit these changes before merging.");
    return exitSoon(2);
  }

  // Capture pre-merge HEAD for rollback
  const projectPreSha = runGit(["rev-parse", "HEAD"], projectRoot).stdout.trim();
  const projectPreBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], projectRoot).stdout.trim();

  // Connect to pipeline DB; enforce qa_pass invariant
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

  function mark(idx, state) {
    // Progress marks are best-effort — never let them block the merge
    try { progressMark(db, sessionSlug, idx, state); } catch { /* ignore */ }
  }

  let exitCode = 0;
  try {
    // Step 0b — create progress entry
    step0bProgress(db, project, sessionSlug, args.parent);

    // Step 0a (idx 0)
    mark(0, "inprogress");
    if (args.noRebase) {
      logOut("[0a] --no-rebase: skipping rebase as requested by operator");
    } else {
      const rebaseOk = await step0aRebase(projectRoot, project, branches, targetBranch);
      if (!rebaseOk) throw new MergeAbort(3, "step 0a (rebase)");
    }
    mark(0, "done");

    // Step 1 (idx 1)
    mark(1, "inprogress");
    const plFiles = step1IdentifyPlans(db, project, branches, { plansDir: args.plansDir });
    mark(1, "done");

    // Step 2 (idx 2)
    mark(2, "inprogress");
    const blockers = await step2VerifyDone(db, plFiles, projectRoot, project, {
      skipTesting: args.skipTesting,
      targetBranch,
    });
    if (blockers.length) {
      for (const b of blockers) logErr(`BLOCKER: ${b}`);
      throw new MergeAbort(4, `step 2 (definition of done) — ${blockers.length} blocker(s)`);
    }
    mark(2, "done");

    // Step 3 (idx 3)
    mark(3, "inprogress");
    await step3UpdateStatus(plFiles, projectRoot, project);
    mark(3, "done");

    // Step 4 (idx 4) — doc-impact removed (fragile LLM call, human judgment preferred)

    // Step 5 — squash merge (idx 5)
    mark(5, "inprogress");
    await step5SquashMerge(db, project, projectRoot, branches, plFiles, targetBranch);
    mark(5, "done");

    // Step 6 — move plans (idx 6)
    mark(6, "inprogress");
    step6MovePlans(plFiles);
    // Mark plans complete in the DB
    for (const branch of branches) {
      const slug = branchSlug(branch);
      try {
        planSetStatus(db, project, slug, 'complete');
      } catch { /* ignore if plan not in DB */ }
    }
    mark(6, "done");

    // Step 6b — archive orphaned done plans (no dedicated progress step)
    step6bArchiveOrphanedPlans(db, project, { plansDir: args.plansDir });

    // Step 7 — commit project (idx 7)
    mark(7, "inprogress");
    await step7CommitProject(projectRoot, branches, { plansDir: args.plansDir });
    if (!pushTarget(projectRoot, targetBranch, { log: logOut, err: logErr })) throw new MergeAbort(7, "step 7b (push)");
    mark(7, "done");

    // Step 8 — smoke check (idx 8)
    if (!args.skipSmoke) {
      mark(8, "inprogress");
      const smokeCmd = readSmokeCommand(join(projectRoot, "CLAUDE.md"));
      if (!step8Smoke(projectRoot, smokeCmd)) throw new MergeAbort(5, "step 8 (smoke check)");
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
    // Rollback on failure — not smoke (5) or push (7): the merge landed, and they are operator-recoverable
    if (![0, 5, 7].includes(exitCode)) {
      logErr(`[rollback] merge failed (exit=${exitCode}); resetting project head`);
      const curBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], projectRoot, { check: false }).stdout.trim();
      if (curBranch !== projectPreBranch) {
        logErr(`  HEAD on '${curBranch}', not pre-merge '${projectPreBranch}' — checking out first`);
        const co = runGit(["checkout", projectPreBranch], projectRoot, { check: false });
        if (co.code !== 0) {
          logErr(`  BLOCKER — could not checkout '${projectPreBranch}': ${co.stderr.trim()}; skipping reset`);
          close(db);
          return exitSoon(exitCode);
        }
      }
      logErr(`  project (${projectPreBranch}) -> ${projectPreSha.slice(0, 7)}`);
      runGit(["reset", "--hard", projectPreSha], projectRoot, { check: false });
    }

    // Step 9 — cleanup progress (always runs)
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
