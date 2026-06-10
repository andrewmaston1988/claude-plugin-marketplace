# pipeline plugin

## Target branch

`queue-plan` resolves a row's `target_branch` (the merge destination) via this precedence chain — first hit wins:

1. Row's `target_branch` column (set explicitly at queue time / admin override).
2. Plan file's `*Target-Branch: <name>*` annotation.
3. Operator's `--target-branch` flag on `queue-plan`.
4. `detectDefaultBranch(projectRoot)` — `git symbolic-ref refs/remotes/origin/HEAD`, then `git config init.defaultBranch`.
5. `DEFAULT_TARGET_BRANCH_FALLBACK` (`"main"`, exported from `src/cli/helpers.mjs`).

Once a row has `target_branch` stored, the column wins — the chain only runs at queue time. Hardcoded `"master"` is a defect; route through `detectDefaultBranch` instead.

`lintTargetBranchProse` emits a one-line warning (not error) when `--target-branch` carries a prefix not in `cfg.recognised_branch_types` (default `["autonomous", "interactive"]`). Unusual destinations are allowed.
