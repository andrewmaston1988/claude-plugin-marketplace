# Pipeline plugin

## Worktree layout

**One worktree per feature.** As of phase 3b, every pipeline-managed session for a feature — dev, research, review, test, merge — operates inside a single git worktree at:

```
{root_parent}/.worktrees/{project}/{feature}
```

Override via `cfg.worktree_base`. The orchestrator creates the worktree on first spawn for a feature; review/test sessions create it on demand if the feature was queued straight to them.

### Reports are published to side-branches

The single worktree sits on `autonomous/{feature}` for dev work. Reports (code-review verdicts, qa-test reports) are written into subdirectories of the worktree (`reports/`, `test-reports/`) but **published to their own side-branches** via a stash-switchback dance so the merge skill can still read verdicts from git history:

1. `git stash push -u` (protect dev WIP)
2. `git checkout -B {kind}/{feature}` (the publish branch)
3. `git add <report>` + `git commit`
4. `git checkout autonomous/{feature}`
5. `git stash pop`

If step 5 conflicts, the row parks at `manual` with `[stash-pop-conflict]` and the stash ref is preserved for operator recovery. The side-branch template is `cfg.report_publish_branch_template` (default `{kind}/{feature}`).

### Serial-session invariant — load-bearing

This design depends on the orchestrator's existing per-project serialisation: at most one session per project is active at a time. If concurrency policy ever relaxes — two sessions on the same feature concurrently — the one-worktree-per-feature model breaks (two processes racing on `git checkout` and the stash slot). The doctor's `worktree-layout-stale` check warns when on-disk worktrees diverge from the resolved template; treat that as the manual-migration nudge.

### Migration

There is no automatic migration of pre-3b on-disk worktrees. The doctor's `worktree-layout-stale` check prints a `git worktree remove <path>` command per stale entry; operators run them by paste.
