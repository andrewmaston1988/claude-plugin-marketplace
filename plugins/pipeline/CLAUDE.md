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

**Order matters in the dance.** Review reports are written *after* the stash + checkout (the heredoc happens on the publish branch). Test reports are written *during* the session, so the test-session stash uses `-- . ':!test-reports/'` to scope-exclude the report directory from the stash; without that exclusion `-u` would sweep the just-written report away and the subsequent `git add` would fail. Any new report-writing dance must follow one of the two orderings — never write to the working tree before an unscoped `git stash push -u`.

**Per-retry publish branches are force-overwritten.** Each cycle runs `git checkout -B {kind}/{feature}`, which resets the publish branch to the current dev HEAD plus the new report. Prior-retry report commits become unreachable from the branch tip (gc-eligible). The merge skill only consumes the latest verdict, so functionally this is fine, but the per-retry audit trail is *not* preserved on the side-branch — re-run history must be reconstructed from `reports/` filenames (each retry has a unique `retry<N>-<corr_id>` suffix) and the pipeline's `cycle_log`. If long-term audit becomes a requirement, switch to `checkout {kind}/{feature} || checkout -B …` so subsequent retries commit on top of the prior tip.

**`CODE_REVIEW_WT` / `QA_TEST_WT` are load-bearing aliases for `{{WORKTREE}}`.** `session-gen.mjs` substitutes the legacy `{{CODE_REVIEW_WT}}` and `{{QA_TEST_WT}}` placeholders to the same value as `{{WORKTREE}}` so pre-3b templates and `dev-session.md`'s prior-report-discovery blocks (which still reference the legacy names) keep resolving correctly. The aliases must not diverge from `WORKTREE` while any template still uses them.

### Serial-session invariant — load-bearing

This design depends on the orchestrator's existing per-project serialisation: at most one session per project is active at a time. If concurrency policy ever relaxes — two sessions on the same feature concurrently — the one-worktree-per-feature model breaks (two processes racing on `git checkout` and the stash slot). The doctor's `worktree-layout-stale` check warns when on-disk worktrees diverge from the resolved template; treat that as the manual-migration nudge.

### Migration

There is no automatic migration of pre-3b on-disk worktrees. The doctor's `worktree-layout-stale` check prints a `git worktree remove <path>` command per stale entry; operators run them by paste.
