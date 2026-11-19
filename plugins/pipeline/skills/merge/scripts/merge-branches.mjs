// merge-branches.mjs — step 5: turn each branch into one squash commit in the
// merge worktree, via an open PR, the operator's on_merge hook, or locally.
//
// Split out of merge.mjs at a seam: merge.mjs is over the file-size bar and
// may not grow. Re-exported from merge.mjs, so no call site changes.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { rowUpdate } from "../../../src/db/index.mjs";
import {
  GitError, runGit, gitCommitWithRetry, gitMergeSquashWithRetry,
} from "./rebase.mjs";
import { branchSlug } from "./plan-files.mjs";
import { pushTarget, parkSquash } from "./land.mjs";
import { loadPipelineConfig } from "../../../src/pipeline-config.mjs";
import { getPaths } from "../../../src/paths.mjs";
import { resolveHookFirstToken } from "../../../src/worktree-paths.mjs";

const logOut = (m) => process.stdout.write(m + "\n");
const logErr = (m) => process.stderr.write(m + "\n");

// Steps that fail on their own terms (rebase, DoD gate, smoke) abort with their
// own exit code. Thrown, never `return`ed: a return inside the try skips the
// trailing process.exit and a caller reads the failed merge as landed.
export class MergeAbort extends Error {
  constructor(code, message) {
    super(message);
    this.exitCode = code;
  }
}

function readPlanGoal(planPath) {
  if (!planPath || !existsSync(planPath)) return "";
  const text = readFileSync(planPath, "utf8");
  const m = /^##\s*Goal\s*$(.*?)(?=^##\s)/ms.exec(text);
  if (!m) return "";
  return m[1].trim().split("\n\n")[0];
}

function writeCommitMessage(projectDir, branch, planPath, targetBranch = "main") {
  const goal = readPlanGoal(planPath);
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

export async function step5SquashMerge(
  db, project, projectDir, wt, branches, planFiles, targetBranch = "main",
  { spawn = _defaultSpawn, log = logOut, err = logErr } = {},
) {
  const cfg = loadPipelineConfig();
  const paths = getPaths();
  const onMergeHook = resolveHookFirstToken(cfg?.hooks?.on_merge, paths.configDir);
  const hasOrigin = runGit(["remote", "get-url", "origin"], projectDir, { check: false }).code === 0;

  // Before a remote merge, origin must hold every squash committed so far —
  // otherwise the next branch builds on a base origin does not have.
  function pushPending(label) {
    if (!hasOrigin) return;
    runGit(["fetch", "origin", targetBranch], wt.path, { check: false });
    const behind = runGit(["rev-list", "--count", `origin/${targetBranch}..HEAD`], wt.path, { check: false });
    if (behind.code !== 0 || parseInt(behind.stdout.trim() || "0", 10) === 0) return;
    const sha = runGit(["rev-parse", "HEAD"], wt.path).stdout.trim();
    if (!pushTarget(wt.path, targetBranch, { sha, log, err })) {
      parkSquash(projectDir, targetBranch, sha);
      throw new MergeAbort(7, `step 5 (${label} push)`);
    }
  }

  function resync() {
    if (hasOrigin) wt.resync(`origin/${targetBranch}`);
  }

  for (const branch of branches) {
    const slug = branchSlug(branch);

    // Always check for an open PR first, regardless of whether hooks.on_merge
    // is configured. Operator hooks are unreliable for PR merges: `gh pr merge
    // <branch>` can disambiguate the branch wrongly, and a branch-protected
    // repo refuses the merge without --admin.
    const pr = findOpenPR(branch, projectDir, { spawn });
    if (pr) {
      log(`[5] Open PR found (#${pr.number}) for ${branch} — using gh pr merge`);
      pushPending("pre-PR");
      const mergeResult = spawn("gh", ["pr", "merge", String(pr.number), "--squash", "--admin"], {
        cwd: projectDir,
        stdio: "inherit",
        windowsHide: true,
      });
      if (mergeResult.status !== 0) {
        throw new GitError(`gh pr merge #${pr.number} failed (exit ${mergeResult.status}). Refusing local fallback.`);
      }
      log(`[5] PR #${pr.number} merged via gh pr merge`);
      resync();
    } else if (onMergeHook) {
      // No PR — fall through to the operator hook. Already-integrated guard:
      // 0 commits ahead means the work is already on origin, so skip the hook
      // rather than double-merge into diverging states.
      const aheadResult = runGit(
        ["rev-list", "--left-right", "--count", `${targetBranch}...${branch}`],
        wt.path, { check: false },
      );
      const aheadCount = aheadResult.code === 0
        ? parseInt(aheadResult.stdout.trim().split(/\s+/)[1] ?? "0", 10)
        : -1;

      if (aheadCount === 0) {
        log(`[5] ${branch} has 0 commits ahead of ${targetBranch} — already integrated, skipping hook`);
        resync();
      } else {
        // The hook owns the git operation. cwd is the merge worktree: it may
        // run git, and it must not run it in the shared checkout.
        log(`[5] Invoking hooks.on_merge for ${branch}`);
        pushPending("pre-hook");
        const env = {
          ...process.env,
          PIPELINE_PROJECT: project,
          PIPELINE_FEATURE: slug,
          PIPELINE_BRANCH: branch,
          PIPELINE_TARGET_BRANCH: targetBranch,
        };
        const result = spawnSync(process.execPath, [onMergeHook], {
          env, stdio: "inherit", cwd: wt.path, windowsHide: true,
        });
        if (result.status !== 0) {
          throw new GitError(`hooks.on_merge failed for ${branch} (exit ${result.status})`);
        }
        log(`[5] hooks.on_merge completed for ${branch}`);
        resync();
      }
    } else {
      log(`[5] No open PR for ${branch} — squash-merging locally`);

      const aheadBehind = runGit(
        ["rev-list", "--left-right", "--count", `${targetBranch}...${branch}`],
        wt.path, { check: false },
      );
      const ahead = aheadBehind.code === 0
        ? parseInt(aheadBehind.stdout.trim().split(/\s+/)[1], 10)
        : -1;

      let alreadyIntegrated = false;
      if (ahead === 0) {
        log(`[5] ${branch} is already integrated into ${targetBranch} — verifying`);
        const guardBlockers = verifyAlreadyIntegrated(planFiles[branch], wt.path);
        if (guardBlockers.length) {
          for (const b of guardBlockers) err(`BLOCKER: ${b}`);
          throw new GitError(
            `${branch}: already-integrated check failed — branch may have committed to detached HEAD. ` +
            `Inspect dangling commits via \`git fsck --lost-found\` and recover manually.`,
          );
        }
        log(`[5] ${branch} verified as integrated — skipping squash merge, running cleanup`);
        alreadyIntegrated = true;
      } else {
        const mergeResult = await gitMergeSquashWithRetry(wt.path, branch);
        if (mergeResult.code !== 0) {
          const combined = (mergeResult.stdout + mergeResult.stderr).toLowerCase();
          if (combined.includes("already up to date") || combined.includes("nothing to commit")) {
            log(`[5] ${branch} had no changes to merge — treating as already integrated`);
            alreadyIntegrated = true;
          } else {
            throw new GitError(`squash merge failed for ${branch}: ${mergeResult.stderr.trim()}`);
          }
        }
      }

      if (!alreadyIntegrated) {
        const message = writeCommitMessage(projectDir, branch, planFiles[branch], targetBranch);
        await gitCommitWithRetry(wt.path, "-m", message);
        const commitHash = runGit(["rev-parse", "--short", "HEAD"], wt.path).stdout.trim();
        log(`[5] Committed ${commitHash}`);
      } else {
        const commitHash = runGit(["rev-parse", "--short", "HEAD"], wt.path, { check: false }).stdout.trim();
        log(`[5] ${branch} cleanup path — head at ${commitHash}, no new commit`);
      }
    }

    // Advance pipeline row to done — shared regardless of merge path
    if (db) {
      try {
        rowUpdate(db, project, slug, { stage: "done" });
      } catch (e) {
        err(`[5] WARN: could not advance ${slug} to done: ${e.message}`);
      }
    }
  }
}
