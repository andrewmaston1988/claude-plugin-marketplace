# Pipeline plugin

## Configuration knobs

All keys live in `~/.pipeline/config.json` and are deep-merged over `PIPELINE_DEFAULTS` at load time. Missing keys fall back to the defaults below.

| Key | Default | Notes |
|---|---|---|
| `web.port` | `8765` | Port the web dashboard listens on. Override with `--port` on the CLI for a single session. Doctor check `web-port-conflict` warns when a foreign process occupies this port. |
| `governor.enabled` | `false` | Opt-in to scheduled background governance reports. Also set `governor.project`. |
| `governor.project` | `null` | Name of the registered project whose root is used as fallback for `reports_dir`, `session_dir`, `log_dir`. |
| `governor.template_path` | _(bundled)_ | Path to a custom governor session template. Relative paths resolve from `~/.pipeline/`. |
| `governor.reports_dir` | `<project-root>/reports` | Where governance markdown reports land. |
| `governor.session_dir` | `<project-root>/sessions` | Where governor session files are written. |
| `governor.log_dir` | `<project-root>/logs` | Where governor stdout/stderr logs go. |
| `web.host` | `"127.0.0.1"` | Network interface the dashboard binds to. `"127.0.0.1"` = loopback-only; `"0.0.0.0"` = all interfaces (LAN access). Override with `--host` on the CLI for a single session. |

**Slack-bridge tokens**: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `CLAUDE_CWD` are env-var overrides for the slack-bridge's `tokens.bot`, `tokens.app`, and `claude.cwd` config keys respectively. Env vars win over config values. Full mapping: `plugins/slack-bridge/CONFIG.md`.

**Governor spawn contract**: when the governor is enabled, the orchestrator sets `CORRELATION_ID`, `REPORT_TYPE`, `REPORT_DATE`, `REPORT_MONTH`, `PIPELINE_DB`, and `PLUGIN_DIR` in the child process env before launching the governor session. Doctor check `governor-env-contract` verifies the template doesn't reference vars outside this set.

## Worktree layout

**One worktree per feature.** As of phase 3b, every pipeline-managed session for a feature — dev, research, review, test, merge — operates inside a single git worktree at:

```
{root_parent}/.worktrees/{project}/{feature}
```

Override via `cfg.worktree_base`. The orchestrator creates the worktree on first spawn for a feature; review/test sessions create it on demand if the feature was queued straight to them.

The **branch checked out** inside that worktree is whatever the row declares (`row.branch`, set by `queue-plan --branch` or a plan's `*Branch:*` annotation), resolved through `resolveRowBranch` — authoritative for any name. It defaults to `autonomous/<plan-stem>` when nothing is declared. The worktree **directory** name stays plan-stem-derived regardless of the branch, so a directory like `…/feat-x` may hold a branch such as `anm/PROJ-101_tooltips`. The session templates verify `{{BRANCH}}` (the resolved branch), and `spawn.mjs` refuses to launch — parking the row at `manual` with `[branch-equals-target]` — if the resolved branch equals the merge target or repo default.

The fresh-install wizard prompts for this in `Step 7/11 — Worktree layout` (`src/setup/wizard.mjs`); the conversational walkthrough lives under `Question 3f — Worktree layout` in `skills/pipeline-setup/SKILL.md`.

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

**Helpers detect post-dance state via `--publish-branch`.** `review-complete` and `test-complete` accept `--publish-branch {{REVIEW_PUBLISH_BRANCH|TEST_PUBLISH_BRANCH}}`. When the report file is absent from the dev-branch working tree but reachable via `git cat-file -e <publish-branch>:<relpath>`, the helper recognises that the session's dance already committed the report on the side-branch and skips its own add+commit. Both `pathspec did not match` (file not on disk) and `nothing to commit` (race with a parallel call) are tolerated as success signals; the helper still advances the row + notifies. Templates must pass `--publish-branch` — without it the helper falls back to legacy "report must exist on disk" semantics and exits 2 after the dance.

**Dev-session prior-report discovery reads from the publish branch, not from disk.** After the dance, `{{WORKTREE}}/reports/` (and `test-reports/`) are empty on the dev branch. `dev-session.md`'s discovery block enumerates via `git -C {{WORKTREE}} ls-tree -r --name-only {{REVIEW_PUBLISH_BRANCH}} -- reports/` and reads via `git show {{REVIEW_PUBLISH_BRANCH}}:<path>`. Filesystem `ls` against the worktree silently finds nothing post-3b — the bounce-back review→dev feedback loop depends on the `git show` path.

**`CODE_REVIEW_WT` / `QA_TEST_WT` are load-bearing aliases for `{{WORKTREE}}`.** `session-gen.mjs` substitutes the legacy `{{CODE_REVIEW_WT}}` and `{{QA_TEST_WT}}` placeholders to the same value as `{{WORKTREE}}` so pre-3b templates and `dev-session.md`'s prior-report-discovery blocks (which still reference the legacy names) keep resolving correctly. The aliases must not diverge from `WORKTREE` while any template still uses them.

### Serial-session invariant — load-bearing

This design depends on the orchestrator's existing per-project serialisation: at most one session per project is active at a time. If concurrency policy ever relaxes — two sessions on the same feature concurrently — the one-worktree-per-feature model breaks (two processes racing on `git checkout` and the stash slot). The doctor's `worktree-layout-stale` check warns when on-disk worktrees diverge from the resolved template; treat that as the manual-migration nudge.

### Migration

There is no automatic migration of pre-3b on-disk worktrees. The doctor's `worktree-layout-stale` check prints a `git worktree remove <path>` command per stale entry; operators run them by paste.
