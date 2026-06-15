import { spawnSync as _spawnSync } from "node:child_process";

// Execute gh CLI and return parsed JSON output, or null on failure.
function _gh(args, cwd) {
  try {
    const r = _spawnSync("gh", args, { cwd, encoding: "utf8", windowsHide: true });
    if (r.status !== 0) return null;
    return JSON.parse(r.stdout.trim());
  } catch { return null; }
}

/**
 * Detect whether a prerequisite branch's content has landed on a target branch,
 * even after a squash-merge (which breaks git ancestry).
 *
 * Probes in order — first truthy result wins:
 *   1. ancestor  — git merge-base --is-ancestor (fast path; regular/FF merges)
 *   2. cherry    — git cherry shows zero unmerged commits (squash/rebase aware)
 *   3. pr-merged — gh pr list --state merged confirms the PR landed on GitHub
 *   4. branch-deleted — remote no longer carries the branch (post-squash cleanup)
 *
 * @param {string} prereqBranch  e.g. "autonomous/pipeline-absorb-phase-3-readers"
 * @param {string} targetBranch  e.g. "master"
 * @param {string} projectRoot   absolute path to the git repo
 * @param {object} opts          injectable deps for testing
 * @returns {{ landed: boolean, signal: string }}
 */
export function isPrereqLanded(prereqBranch, targetBranch, projectRoot, {
  spawnSync = _spawnSync,
  gh = _gh,
  logFn = () => {},
} = {}) {
  const run = (cmd, args) => {
    try {
      return spawnSync(cmd, args, { cwd: projectRoot, encoding: "utf8", windowsHide: true });
    } catch { return { status: 1, stdout: "", stderr: "" }; }
  };

  // Signal 1: ancestry (works for regular and fast-forward merges)
  const ancestorResult = run("git", ["merge-base", "--is-ancestor", prereqBranch, targetBranch]);
  if (ancestorResult.status === 0) {
    logFn(`  [landed] ${prereqBranch} → ${targetBranch}: signal=ancestor`);
    return { landed: true, signal: "ancestor" };
  }

  // Signal 2: git cherry — lists commits in prereqBranch not equivalent in targetBranch.
  // A squash-merge preserves the diff, so all commits show as "-" (already in target).
  // If there are no "+" lines, the content landed.
  // Guard: verify prereqBranch exists before cherry — git cherry exits 0 with empty
  // stdout on some versions when the head ref is unknown, which would be a false positive.
  const verifyResult = run("git", ["rev-parse", "--verify", prereqBranch]);
  if (verifyResult.status === 0) {
    const cherryResult = run("git", ["cherry", targetBranch, prereqBranch]);
    if (cherryResult.status === 0) {
      const plusLines = (cherryResult.stdout || "").split("\n").filter(l => l.startsWith("+"));
      if (plusLines.length === 0) {
        logFn(`  [landed] ${prereqBranch} → ${targetBranch}: signal=cherry`);
        return { landed: true, signal: "cherry" };
      }
    }
  } else {
    logFn(`  [landed] ${prereqBranch} unknown to git — skipping cherry`);
  }

  // Signal 3: gh pr list — canonical signal for GitHub squash-merge flow.
  // NOTE: assumes the PR targets the default base; non-default target_branch rows
  // still benefit from signals 1 and 2 above.
  const prData = gh(["pr", "list", "--head", prereqBranch, "--state", "merged",
    "--json", "mergedAt", "-L", "1"], projectRoot);
  if (Array.isArray(prData) && prData.length > 0 && prData[0].mergedAt) {
    logFn(`  [landed] ${prereqBranch} → ${targetBranch}: signal=pr-merged (mergedAt=${prData[0].mergedAt})`);
    return { landed: true, signal: "pr-merged" };
  }

  // Signal 4: remote branch deletion — GitHub deletes source branch on squash-merge.
  // Weakest signal; tie-breaker only.
  const lsResult = run("git", ["ls-remote", "--heads", "origin", prereqBranch]);
  if (lsResult.status === 0 && (lsResult.stdout || "").trim() === "") {
    logFn(`  [landed] ${prereqBranch} → ${targetBranch}: signal=branch-deleted`);
    return { landed: true, signal: "branch-deleted" };
  }

  logFn(`  [landed] ${prereqBranch} → ${targetBranch}: signal=none (all probes negative)`);
  return { landed: false, signal: "none" };
}
