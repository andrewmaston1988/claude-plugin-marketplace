// Step 5 of merge.mjs — squash-merge each branch: an open PR via gh, else the on_merge hook, else a local squash.
import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";

import { rowUpdate } from "../../../src/db/index.mjs";
import {
  GitError,
  runGit,
  gitCommitWithRetry,
  gitMergeSquashWithRetry,
  gitCheckoutWithRetry,
} from "./rebase.mjs";
import { branchSlug } from "./plan-files.mjs";
import { cleanupBranch } from "./land.mjs";
import { loadPipelineConfig } from "../../../src/pipeline-config.mjs";
import { getPaths } from "../../../src/paths.mjs";
import { orchestratorWorktreePath, resolveHookFirstToken } from "../../../src/worktree-paths.mjs";

export function logOut(msg) { process.stdout.write(msg + "\n"); }
export function logErr(msg) { process.stderr.write(msg + "\n"); }

function worktreePath(projectDir, slug) {
  return orchestratorWorktreePath({
    project: basename(projectDir),
    projectRoot: projectDir,
    branch: `autonomous/${slug}`,
  });
}

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

export function findOpenPR(branch, projectDir, { spawn = spawnSync, log = logErr } = {}) {
  const result = spawn("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number,mergeStateStatus"], {
    cwd: projectDir,
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    const prs = JSON.parse(result.stdout);
    if (!Array.isArray(prs) || prs.length === 0) return null;
    return { number: prs[0].number, mergeStateStatus: prs[0].mergeStateStatus };
  } catch (e) {
    log(`[findOpenPR] gh pr list returned non-JSON: ${result.stdout.slice(0, 120)}`);
    return null;
  }
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

// Defaultable spawn so tests can substitute a fake. The real call paths use
// the imported spawnSync.
const _defaultSpawn = (...args) => spawnSync(...args);

export async function step5SquashMerge(db, project, projectDir, branches, planFiles, targetBranch = "main", { spawn = _defaultSpawn } = {}) {
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

    // Always check for an open PR first, regardless of whether hooks.on_merge
    // is configured. Operator hooks are unreliable for PR merges (branch-name
    // disambiguation in `gh pr merge <branch>` and missing --admin on
    // branch-protected repos) — see plan merge-skip-hook-for-pr. PR merges
    // always go through `gh pr merge <number> --squash --admin`.
    const pr = findOpenPR(branch, projectDir, { spawn });
    if (pr) {
      logOut(`[5] Open PR found (#${pr.number}) for ${branch} — using gh pr merge`);
      const mergeResult = spawn("gh", ["pr", "merge", String(pr.number), "--squash", "--admin"], {
        cwd: projectDir,
        stdio: "inherit",
        windowsHide: true,
      });
      if (mergeResult.status !== 0) {
        throw new GitError(`gh pr merge #${pr.number} failed (exit ${mergeResult.status}). Refusing local fallback.`);
      }
      logOut(`[5] PR #${pr.number} merged via gh pr merge`);
      // Fast-forward local target to origin — the PR merge happened on remote
      runGit(["fetch", "origin", targetBranch], projectDir, { check: false });
      const ffPost = runGit(["merge", "--ff-only", `origin/${targetBranch}`], projectDir, { check: false });
      if (ffPost.code !== 0) logErr(`[5] WARN: ff-sync failed after gh pr merge: ${ffPost.stderr.trim()}`);
    } else if (onMergeHook) {
      // No PR — fall through to the operator hook for local-merge handling.
      // Already-integrated guard for hook path: 0 commits ahead means the work is
      // already on origin (e.g. from a prior run). Skip the hook to avoid a
      // double-merge that leaves local and origin in diverging states.
      const aheadResult = runGit(
        ["rev-list", "--left-right", "--count", `${targetBranch}...${branch}`],
        projectDir, { check: false },
      );
      const aheadCount = aheadResult.code === 0
        ? parseInt(aheadResult.stdout.trim().split(/\s+/)[1] ?? "0", 10)
        : -1;

      if (aheadCount === 0) {
        logOut(`[5] ${branch} has 0 commits ahead of ${targetBranch} — already integrated, skipping hook`);
        runGit(["fetch", "origin", targetBranch], projectDir, { check: false });
        const ffSkip = runGit(["merge", "--ff-only", `origin/${targetBranch}`], projectDir, { check: false });
        if (ffSkip.code !== 0) logErr(`[5] WARN: ff-sync failed after already-integrated skip: ${ffSkip.stderr.trim()}`);
      } else {
        // Delegate the merge to hooks.on_merge — it owns the git operation.
        // Env vars match the on_merge_ready pattern for consistency.
        // Before changing where or how the hook runs, read a real installed hook,
        // e.g. the one `hooks.on_merge` in ~/.pipeline/config.json points at. Client
        // hooks rely on this exact contract: the operator's one squash-commits into
        // its cwd on main without pushing and deletes the branch, trusting step 7b to
        // push. Moving its cwd off main (#485, reverted) silently dropped that commit.
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
        // Fast-forward local target to origin — the hook merged via gh pr merge on
        // origin, so local master is now behind by one squash commit.
        runGit(["fetch", "origin", targetBranch], projectDir, { check: false });
        const ffPost = runGit(["merge", "--ff-only", `origin/${targetBranch}`], projectDir, { check: false });
        if (ffPost.code !== 0) logErr(`[5] WARN: ff-sync failed after hook merge: ${ffPost.stderr.trim()}`);
      }
    } else {
      logOut(`[5] No open PR for ${branch} — squash-merging locally`);

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
    await cleanupBranch(projectDir, branch, worktreePath(projectDir, slug), { log: logOut, err: logErr });
  }
}
