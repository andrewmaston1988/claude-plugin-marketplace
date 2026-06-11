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
import { existsSync, readFileSync } from "node:fs";
import { join, basename, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  connectUnified, close,
  rowGet, rowUpdate,
  progressMark,
} from "../../../scripts/pipeline-db/index.mjs";
import {
  GitError,
  runGit,
  gitAddWithRetry,
  gitCommitWithRetry,
  gitMergeSquashWithRetry,
  gitCheckoutWithRetry,
  gitWorktreeWithRetry,
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
import { loadPipelineConfig } from "../../../src/pipeline-config.mjs";
import { getPaths } from "../../../src/paths.mjs";
import { orchestratorWorktreePath, resolveHookFirstToken } from "../../../scripts/worktree-paths.mjs";

// ── Subprocess helpers ────────────────────────────────────────────────────────

function logOut(msg) { process.stdout.write(msg + "\n"); }
function logErr(msg) { process.stderr.write(msg + "\n"); }

// ── Path helpers ──────────────────────────────────────────────────────────────

function worktreePath(projectDir, slug) {
  return orchestratorWorktreePath({
    project: basename(projectDir),
    projectRoot: projectDir,
    branch: `autonomous/${slug}`,
  });
}

function projectName(projectDir) {
  return basename(projectDir);
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

function _readPlanGoal(planPath) {
  if (!planPath || !existsSync(planPath)) return "";
  const text = readFileSync(planPath, "utf8");
  const m = /^##\s*Goal\s*$(.*?)(?=^##\s)/ms.exec(text);
  if (!m) return "";
  return m[1].trim().split("\n\n")[0];
}

function _writeCommitMessage(projectDir, branch, planPath, targetBranch = "main") {
  const goal = _readPlanGoal(planPath);
  const diff = runGit(["diff", "--name-only", `${targetBranch}...${branch}`], projectDir, { check: false });
  const fileCount = diff.stdout.split("\n").filter(l => l.trim()).length;
  const slug = branchSlug(branch);
  const title = goal ? goal.split("\n")[0].slice(0, 72) : `Merge ${slug}`;
  return fileCount ? `${title}\n\n- ${fileCount} file(s) changed` : title;
}

export function verifyAlreadyIntegrated(planPath, projectDir) {
  if (!planPath || !existsSync(planPath)) return [];
  const text = readFileSync(planPath, "utf8");
  const rowRe = /^\|\s*`([^`]+)`\s*\|\s*(Create|Add)\b/gim;
  const missing = [];
  let m;
  while ((m = rowRe.exec(text)) !== null) {
    const rel = m[1].trim();
    if (!existsSync(join(projectDir, rel))) {
      missing.push(`  claimed Create/Add \`${rel}\` not found on main`);
    }
  }
  if (missing.length) {
    return ["already-integrated path taken but plan claims files absent from main:"].concat(missing);
  }
  return [];
}

async function step5SquashMerge(db, project, projectDir, branches, planFiles, targetBranch = "main") {
  const co = await gitCheckoutWithRetry(projectDir, targetBranch);
  if (co.code !== 0) {
    process.stderr.write(`BLOCKER: target branch '${targetBranch}' not found\n`);
    process.stderr.write((co.stderr || "").trim() + "\n");
    throw new GitError(`checkout ${targetBranch} failed`);
  }

  const cfg = loadPipelineConfig();
  const paths = getPaths();
  const onMergeHook = resolveHookFirstToken(cfg?.hooks?.on_merge, paths.configDir);

  for (const branch of branches) {
    const slug = branchSlug(branch);

    if (onMergeHook) {
      // Delegate the merge to hooks.on_merge — it owns the git operation.
      // Env vars match the on_merge_ready pattern for consistency.
      logOut(`[5] Invoking hooks.on_merge for ${branch}`);
      const env = {
        ...process.env,
        PIPELINE_PROJECT: project,
        PIPELINE_FEATURE: slug,
        PIPELINE_BRANCH: branch,
        PIPELINE_TARGET_BRANCH: targetBranch,
      };
      const result = spawnSync(process.execPath, [onMergeHook], { env, stdio: "inherit" });
      if (result.status !== 0) {
        throw new GitError(`hooks.on_merge failed for ${branch} (exit ${result.status})`);
      }
      logOut(`[5] hooks.on_merge completed for ${branch}`);
    } else {
      logOut(`[5] Squash-merging ${branch}`);

      const aheadBehind = runGit(
        ["rev-list", "--left-right", "--count", `${targetBranch}...${branch}`],
        projectDir, { check: false },
      );
      const ahead = aheadBehind.code === 0
        ? parseInt(aheadBehind.stdout.trim().split(/\s+/)[1], 10)
        : -1;

      let alreadyIntegrated = false;
      if (ahead === 0) {
        logOut(`[5] ${branch} is already integrated into ${targetBranch} — verifying`);
        const planPath = planFiles[branch];
        const guardBlockers = verifyAlreadyIntegrated(planPath, projectDir);
        if (guardBlockers.length) {
          for (const b of guardBlockers) logErr(`BLOCKER: ${b}`);
          throw new GitError(
            `${branch}: already-integrated check failed — branch may have committed to detached HEAD. ` +
            `Inspect dangling commits via \`git fsck --lost-found\` and recover manually.`,
          );
        }
        logOut(`[5] ${branch} verified as integrated — skipping squash merge, running cleanup`);
        alreadyIntegrated = true;
      } else {
        const mergeResult = await gitMergeSquashWithRetry(projectDir, branch);
        if (mergeResult.code !== 0) {
          const combined = (mergeResult.stdout + mergeResult.stderr).toLowerCase();
          if (combined.includes("already up to date") || combined.includes("nothing to commit")) {
            logOut(`[5] ${branch} had no changes to merge — treating as already integrated`);
            alreadyIntegrated = true;
          } else {
            throw new GitError(`squash merge failed for ${branch}: ${mergeResult.stderr.trim()}`);
          }
        }
      }

      if (!alreadyIntegrated) {
        const message = _writeCommitMessage(projectDir, branch, planFiles[branch], targetBranch);
        await gitCommitWithRetry(projectDir, "-m", message);
        const commitHash = runGit(["rev-parse", "--short", "HEAD"], projectDir).stdout.trim();
        logOut(`[5] Committed ${commitHash}`);
      } else {
        const commitHash = runGit(["rev-parse", "--short", "HEAD"], projectDir, { check: false }).stdout.trim();
        logOut(`[5] ${branch} cleanup path — head at ${commitHash}, no new commit`);
      }
    }

    // Advance pipeline row to done — shared regardless of merge path
    if (db) {
      try {
        rowUpdate(db, project, slug, { stage: "done" });
      } catch (e) {
        logErr(`[5] WARN: could not advance ${slug} to done: ${e.message}`);
      }
    }

    // Cleanup worktree and local branch — shared regardless of merge path.
    // Non-fatal: hook may have already deleted the remote branch.
    const wt = worktreePath(projectDir, slug);
    if (existsSync(wt)) {
      const r = await gitWorktreeWithRetry(projectDir, "remove", "--force", wt);
      if (r.code !== 0) logErr(`[5] WARN: worktree remove failed for ${wt}: ${r.stderr.trim()}`);
      else logOut(`[5] Removed worktree: ${wt}`);
    }
    const branchDel = runGit(["branch", "-D", branch], projectDir, { check: false });
    if (branchDel.code !== 0) logErr(`[5] WARN: branch delete failed for ${branch}: ${branchDel.stderr.trim()}`);
    else logOut(`[5] Deleted branch: ${branch}`);
  }
}

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

// ── Step 8 — Smoke check ──────────────────────────────────────────────────────

function readSmokeCommand(projectClaudeMd) {
  if (!existsSync(projectClaudeMd)) return null;
  const text = readFileSync(projectClaudeMd, "utf8");
  // Find the smoke heading, then scan forward within its section for a code fence.
  // Handles prose between heading and fence (e.g. "Run this command:\n```bash\n...").
  const sectionM = /^#+\s+smoke\b[^\n]*/im.exec(text);
  if (!sectionM) return null;
  const after = text.slice(sectionM.index + sectionM[0].length);
  const nextHeading = /^#+\s+/m.exec(after);
  const section = nextHeading ? after.slice(0, nextHeading.index) : after;
  const fenceM = /```(?:bash|sh|powershell|pwsh)?\n([^\n]+)/i.exec(section);
  return fenceM ? fenceM[1].trim() : null;
}

function step8Smoke(projectDir, smokeCmd) {
  if (!smokeCmd) { logOut("[8] No smoke command provided; skipping"); return true; }
  logOut(`[8] Running: ${smokeCmd}`);
  const result = spawnSync(smokeCmd, { shell: true, cwd: projectDir, encoding: "utf8" });
  if (result.status !== 0) {
    logErr(`BLOCKER: smoke check failed (exit ${result.status})`);
    if (result.stdout) logErr(result.stdout.slice(-2000));
    if (result.stderr) logErr(result.stderr.slice(-2000));
    return false;
  }
  logOut("[8] Smoke check passed");
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
    }
  }
  return args;
}

// ── Main orchestration ────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.branches) { logErr("BLOCKER: --branches required"); process.exit(2); }

  const projectDir = args.projectDir ?? process.cwd();
  const project = projectName(projectDir);
  const cfg = loadPipelineConfig();
  const now = new Date();
  const sessionSlug = args.sessionSlug
    ?? `merge_${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;

  const branches = args.branches.split(",").map(b => b.trim()).filter(Boolean);
  if (!branches.length) { logErr("BLOCKER: no branches given"); process.exit(2); }

  // Resolve target branch: CLI > DB > auto-detected default
  let targetBranch = args.targetBranch;
  if (!targetBranch) {
    const db0 = connectUnified();
    try {
      const slug0 = branchSlug(branches[0]);
      const row0 = rowGet(db0, project, slug0);
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
    process.exit(0);
  }

  // Pre-check: refuse if project has staged or unstaged changes
  const staged = runGit(["diff", "--cached", "--name-only"], projectDir, { check: false }).stdout.trim();
  if (staged) {
    logErr(`BLOCKER: project has staged changes — abort to avoid mixing state`);
    logErr(`  staged files:\n${staged}`);
    logErr("  Resolve manually (commit or `git restore --staged <files>`) and retry.");
    process.exit(2);
  }
  const unstaged = runGit(["diff", "--name-only"], projectDir, { check: false }).stdout.trim();
  if (unstaged) {
    logErr(`BLOCKER: project has unstaged changes — abort to protect working tree`);
    logErr(`  unstaged files:\n${unstaged}`);
    logErr("  Stash or commit these changes before merging.");
    process.exit(2);
  }

  // Capture pre-merge HEAD for rollback
  const projectPreSha = runGit(["rev-parse", "HEAD"], projectDir).stdout.trim();
  const projectPreBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], projectDir).stdout.trim();

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
        close(db); process.exit(2);
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
    const rebaseOk = await step0aRebase(projectDir, branches, targetBranch);
    if (!rebaseOk) { exitCode = 3; return; }
    mark(0, "done");

    // Step 1 (idx 1)
    mark(1, "inprogress");
    const plFiles = step1IdentifyPlans(db, project, branches, { plansDir: args.plansDir });
    mark(1, "done");

    // Step 2 (idx 2)
    mark(2, "inprogress");
    const blockers = await step2VerifyDone(db, plFiles, projectDir, project, {
      skipTesting: args.skipTesting,
      targetBranch,
    });
    if (blockers.length) {
      for (const b of blockers) logErr(`BLOCKER: ${b}`);
      exitCode = 4; return;
    }
    mark(2, "done");

    // Step 3 (idx 3)
    mark(3, "inprogress");
    await step3UpdateStatus(plFiles, projectDir, project);
    mark(3, "done");

    // Step 4 (idx 4) — doc-impact removed (fragile LLM call, human judgment preferred)

    // Step 5 — squash merge (idx 5)
    mark(5, "inprogress");
    await step5SquashMerge(db, project, projectDir, branches, plFiles, targetBranch);
    mark(5, "done");

    // Step 6 — move plans (idx 6)
    mark(6, "inprogress");
    step6MovePlans(plFiles);
    mark(6, "done");

    // Step 6b — archive orphaned done plans (no dedicated progress step)
    step6bArchiveOrphanedPlans(db, project);

    // Step 7 — commit project (idx 7)
    mark(7, "inprogress");
    await step7CommitProject(projectDir, branches, { plansDir: args.plansDir });
    mark(7, "done");

    // Step 8 — smoke check (idx 8)
    if (!args.skipSmoke) {
      mark(8, "inprogress");
      const smokeCmd = readSmokeCommand(join(projectDir, "CLAUDE.md"));
      if (!step8Smoke(projectDir, smokeCmd)) { exitCode = 5; return; }
      mark(8, "done");
    }

    logOut("merge.mjs — complete");
  } catch (e) {
    logErr(`[merge] Unexpected error: ${e.message ?? e}`);
    exitCode = 6;
  } finally {
    // Rollback on failure (not smoke failure — that's operator-recoverable)
    if (exitCode !== 0 && exitCode !== 5) {
      logErr(`[rollback] merge failed (exit=${exitCode}); resetting project head`);
      const curBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], projectDir, { check: false }).stdout.trim();
      if (curBranch !== projectPreBranch) {
        logErr(`  HEAD on '${curBranch}', not pre-merge '${projectPreBranch}' — checking out first`);
        const co = runGit(["checkout", projectPreBranch], projectDir, { check: false });
        if (co.code !== 0) {
          logErr(`  BLOCKER — could not checkout '${projectPreBranch}': ${co.stderr.trim()}; skipping reset`);
          close(db);
          process.exit(exitCode);
        }
      }
      logErr(`  project (${projectPreBranch}) -> ${projectPreSha.slice(0, 7)}`);
      runGit(["reset", "--hard", projectPreSha], projectDir, { check: false });
    }

    // Step 9 — cleanup progress (always runs)
    try { step9Cleanup(db, sessionSlug); } catch { /* ignore */ }
    close(db);
  }

  process.exit(exitCode);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { logErr(`[fatal] ${e.message ?? e}`); process.exit(6); });
}
