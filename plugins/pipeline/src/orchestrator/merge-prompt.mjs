// The prompt a spawned merge session runs: check out the target in the shared
// checkout, then run merge.mjs there.
export function mergeSessionPrompt({ branch, pluginRoot, projectRoot, targetBranch, mergeScript, sessionSlug, plansDirFlag }) {
  return [
    `Run the merge for ${branch}.`,
    `plugin-root: ${pluginRoot}. project-dir: ${projectRoot} (the registered project root, where the merge and its on_merge hook run).`,
    `branches: ${branch}`,
    `target-branch: ${targetBranch}`,
    ``,
    `Steps:`,
    `1. Working tree may be dirty — stash with git stash --include-untracked if needed; pop after.`,
    `2. git checkout ${targetBranch}`,
    `3. Run: node "${mergeScript}" --branches ${branch} --project-dir "${projectRoot}" --session-slug ${sessionSlug} --target-branch ${targetBranch} ${plansDirFlag}`,
    `4. If exit non-zero, report BLOCKER lines from stderr.`,
    `5. If exit zero, report: branch merged, plan location, squash commit hash.`,
    `6. Pop stash if created.`,
    `Do NOT ask for confirmation. Proceed or emit BLOCKER and exit.`,
  ].join("\n");
}
