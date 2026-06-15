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
| `orch.concurrency_scope` | `"feature"` | Serialization granularity for orchestrator spawns. `"feature"` (default): multiple features in the same project can run concurrently up to `--max-concurrent`. `"project"`: legacy — at most one session per project at any time. Surface in `pipeline doctor` as `Concurrency scope: <value>`. |
| `orch.max_concurrent` | `3` | Global cap on concurrent Claude sessions across all projects. CLI `--max-concurrent <n>` overrides this for a single launch. Visible in `pipeline doctor` as `Max concurrent: <n>`. Lower to 1–2 near API usage limits; raise for higher throughput. |
| `web.host` | `"127.0.0.1"` | Network interface the dashboard binds to. `"127.0.0.1"` = loopback-only; `"0.0.0.0"` = all interfaces (LAN access). Override with `--host` on the CLI for a single session. |
| `tiers` | `{haiku: "claude-haiku-4-5", sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-8"}` | Canonical model string per tier. Used by auto-escalation to resolve tier-jumps (e.g., Haiku → Sonnet). Update when new models release or default recommendations change. |
| `tier_efforts` | `{haiku: ["low", "medium", "high"], sonnet: ["low", "medium", "high", "max"], opus: ["low", "medium", "high", "xhigh", "max"]}` | Supported effort levels per tier. Auto-escalation respects these when walking the ladder (+2 per retry within tier, clamped to ceiling). Update if models gain/lose effort support. |
| `proxy.url` | `"http://localhost:18081"` | Anthropic-format proxy URL. Any model string that doesn't start with `claude-` (Ollama tags like `gemma4:31b-cloud`, `MiniMax-M3`, `qwen2.5-coder:32b`) routes through this URL with `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` env vars. Anthropic models are unaffected. The proxy must speak the Anthropic Messages format — the canonical implementation is `claude-code-proxy` running on this port. |
| `proxy.auth_token` | `"dummy-local-key"` | Bearer token for the proxy. Ignored by Ollama-served models (Ollama doesn't validate); set to whatever the proxy expects for cloud endpoints. |

**Per-row effort column defaults** (set at queue time via `pipeline queue-plan`, not in config.json):

| Column | Default | Notes |
|---|---|---|
| `r_effort` | `high` | Research session effort. Passed as `--effort` to `claude -p` on the research spawn. Rarely downgraded; research benefits from deeper reasoning. |
| `d_effort` | `medium` | Development session effort. Walked by auto-escalation (+2 per retry within tier). |
| `q_effort` | `low` | QA/test session effort. Most test runs are mechanical; elevate only when test reasoning is required. |
| `rvw_effort` | `high` | Review session effort. Passed as `--effort` to `claude -p` on the review spawn. NOT walked by auto-escalation — review effort is queue-time-pinned. Elevate to `max` for security/concurrency/cross-module diffs. |

**Slack-bridge tokens**: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `CLAUDE_CWD` are env-var overrides for the slack-bridge's `tokens.bot`, `tokens.app`, and `claude.cwd` config keys respectively. Env vars win over config values. Full mapping: `plugins/slack-bridge/CONFIG.md`.

**Governor spawn contract**: when the governor is enabled, the orchestrator sets `CORRELATION_ID`, `REPORT_TYPE`, `REPORT_DATE`, `REPORT_MONTH`, `PIPELINE_DB`, and `PLUGIN_DIR` in the child process env before launching the governor session. Doctor check `governor-env-contract` verifies the template doesn't reference vars outside this set.

## Worktree layout

**One worktree per feature.** As of phase 3b, every pipeline-managed session for a feature — dev, research, review, test, merge — operates inside a single git worktree at:

```
{root_parent}/.worktrees/{project}/{feature}
```

Override via `cfg.worktree_base`. The orchestrator creates the worktree on first spawn for a feature; review/test sessions create it on demand if the feature was queued straight to them.

The **branch checked out** inside that worktree is whatever the row declares (`row.branch`, set by `queue-plan --branch` or a plan's `*Branch:*` annotation), resolved through `resolveRowBranch` — authoritative for any name. It defaults to `autonomous/<plan-stem>` when nothing is declared. The worktree **directory** name stays plan-stem-derived regardless of the branch, so a directory like `…/feat-x` may hold a branch such as `anm/SYM-8773_tooltips`. The session templates verify `{{BRANCH}}` (the resolved branch), and `spawn.mjs` refuses to launch — parking the row at `manual` with `[branch-equals-target]` — if the resolved branch equals the merge target or repo default.

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

The load-bearing constraint is **per-feature**: at most one session per feature may be active at any time. The orchestrator defaults to `orch.concurrency_scope: "feature"` — multiple features in the same project can run concurrently up to `--max-concurrent`. Two sessions on the **same** feature concurrently would break the one-worktree-per-feature model (two processes racing on `git checkout` and the stash slot). Operators who want the old per-project serialisation can set `orch.concurrency_scope: "project"` in `~/.pipeline/config.json`. The doctor's `worktree-layout-stale` check warns when on-disk worktrees diverge from the resolved template; treat that as the manual-migration nudge.

### Migration

There is no automatic migration of pre-3b on-disk worktrees. The doctor's `worktree-layout-stale` check prints a `git worktree remove <path>` command per stale entry; operators run them by paste.

## Diagnostics

**When you need a specific pipeline state file**: `<state-dir>` (used throughout this section) resolves to `~/.pipeline/` on Windows/macOS, or `$XDG_STATE_HOME/pipeline/` (fallback `~/.local/state/pipeline/`) on Linux — derived from `src/paths.mjs`. Key files agents tend to need: `<state-dir>/pipeline.db` (SQLite, all row state + spawn map + cycle log), `<state-dir>/config.json` (deep-merged over `PIPELINE_DEFAULTS`), `<state-dir>/logs/orchestrator.jsonl` (poll cadence + spawn lines), `<state-dir>/notifications/` (envelope queue + `hook.log`), `<state-dir>/hooks/` (operator-installed `on_notification` / `merge_check` / `on_merge_ready` / `on_merge` scripts). Read these directly; do not re-derive paths.

**When a user reports console windows popping up on Windows while the orchestrator is running**: the cause is almost always a `spawn` / `spawnSync` of a console executable (`gh`, `git`, `node`, the claude binary, anything `.exe`/`.cmd`) without `windowsHide: true`. The flag does not propagate — a hidden parent that spawns a console grandchild without re-passing it gets a fresh console allocated. Quickest path: grep the configured hooks (`cfg.hooks.*` → files under `<state-dir>/hooks/`) for `spawn`/`spawnSync` calls missing `windowsHide:`. Then walk the in-plugin chain from `scripts/orchestrator/index.mjs` and `spawn.mjs` down to those same hooks. Cadence narrows the source: every ~30s ↔ orchestrator poll path (`cleanupMergedRows` → `merge_check` is a recurring offender); per-event ↔ a hook fired by `publisher._spawnHook` (one window per notification dispatched).

**When a `waits_on` dependent row stays held after its prerequisite is marked done**: the orchestrator probes four signals in order — `ancestor` (git ancestry, fast), `cherry` (patch-id equivalence, squash-aware), `pr-merged` (GitHub `gh pr list --state merged`, canonical for marketplace squash-merges), `branch-deleted` (remote branch gone post-squash cleanup). The holding log line includes `[signal:<last-tried>]`; the release line reads `landed via <signal>`. If all four remain negative, `gh` availability (`gh auth status`) and network access (`git ls-remote origin`) are the first things to check.

**When triaging an orchestrator that "seems wayward"**: confirm what is actually spawning before suspecting the orchestrator. Useful signals — `<state-dir>/logs/orchestrator.jsonl` for `spawning…`/`spawned …` lines and the `polling…` cadence; `<state-dir>/notifications/hook.log` for forwarder load; `Get-CimInstance Win32_Process -Filter 'Name="…"'` for ParentProcessId, since orchestrator-spawned children and user-launched sessions look identical in `tasklist` but diverge here. Test sessions that exercise `publishNotification` against the real state directory produce a notification-fixture flood (`test-feat-*.json`) — diagnostically that's a clue (look at the dev session being tested), not a bug.
