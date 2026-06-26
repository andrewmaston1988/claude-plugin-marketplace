# pipeline

Pipeline orchestrator plugin for Claude Code — manages multi-stage autonomous dev sessions (dev → review → test → merge) via a SQLite-backed queue, spend tracking, and a notifier-agnostic publisher hook.

Requires Node.js 22+ and the `claude` CLI on PATH. Run `pipeline setup` once to install dependencies and configure the orchestrator.

---

## Pipeline stages

```
queued → dev → review → test → merge → done
               ↓ needs_work (within budget)
               dev (retry, review_retries += 1)
               ↓ needs_work (budget exhausted)
               manual (parked-review-budget-exhausted)
```

- **`queued`** — row is waiting; orchestrator will spawn a dev session by default, or research/review/test if type hint is in notes_extra (legacy) or resolved from the queue command.
- **`dev`** — autonomous dev session implements the plan on `autonomous/<feature>`. The orchestrator spawns this stage directly without needing a `type=` hint. If a dev session dies without handoff (no review verdict), the orchestrator automatically recovers to `review` if within retry budget, otherwise parks at `manual`.
- **`research`** — autonomous research session spawned directly by the orchestrator when the row stage is `research`. Dies without auto-recovery — parks at `manual` on PID death.
- **`test`** — autonomous test session spawned directly by the orchestrator when row stage is `test`, runs the suite and sets `qa_pass`.
- **`review`** — autonomous peer-review pass on the dev diff. Emits one of two verdicts:
  - `ready_to_ship` → advances to `test`.
  - `needs_work` → bounces back to `dev` (`review_retries += 1`). After `review_retry_budget` exhausted, parks at `manual`.
- **`manual`** — operator-actionable parking lot (test failure, reviewer-stuck, budget exhausted, or `[blocked: ...]`).
- **`merge`** — passed `qa_pass=true`, waiting for squash-merge via `/merge`.
- **`done`** — merged to main; row preserved for audit.

### Pipeline row columns

| Column | Description |
|--------|-------------|
| `feature` | Feature slug (primary key) |
| `stage` | Current stage: queued, dev, review, test, manual, merge, or done |
| `branch` | Git branch name (null if not yet created) |
| `pr_title` | PR title for GitHub PR; set at queue time from the `--title` flag, else the plan's `*Title:*` annotation |
| `qa_pass` | Test result: true, false, or null (untested) |
| `notes_extra` | Operator notes |
| `rebase_required` | Flag if branch needs rebase before merge |
| `depends_on` | Comma-separated prerequisite feature slugs; the row holds until all are `done` (soft list gate). A slug may be cross-project as `project:feature` (resolved against that project's row). |
| `waits_on` | Single prerequisite feature slug; the row holds until it is `done` AND its branch is an ancestor of `target_branch` (strict chain gate) |
| `base_branch` | Branch a fresh feature worktree is created from (default: `target_branch`); set to a prerequisite's `autonomous/<slug>` to chain dependent code |

**Invariant:** A row cannot reach `stage=merge` without a gate verdict — either `qa_pass=true` (test path) or `review_verdict=ready_to_ship`. The merge runner enforces this before squash-merging.

**Auto-spawn:** The orchestrator automatically spawns merge children when a pipeline row reaches `stage=merge` with no `rebase_required` flag and all dependencies satisfied. Each project is limited to one concurrent merge to avoid rebase/commit races. On successful exit (code 0), the merge script advances the row to `done`; on failure, the row remains at `merge` and an operator notification is sent.

**Stage-driven spawn:** The orchestrator polls for spawnable rows across multiple stages — `queued`, `dev`, `research`, `test`, and `review` — and spawns the appropriate session type directly from the stage. A row that dies without a session (e.g., dev session with no handoff) can be revived by advancing it to the next stage (e.g., `pipeline stage-set <project> <feature> review`) without needing `type=` hints in notes. This mechanism enables recovery via a single command instead of requiring notes manipulation. For backward compatibility, `queued` rows with `type=` hints in `notes_extra` still route correctly; all other active stages prefer the stage column directly. Spawn attempts are rate-limited by a 60-second grace period per (project, feature) pair to give freshly-spawned sessions time to register in the database.

---

## Related skills

| Skill | When to use |
|-------|-------------|
| `/pipeline [<project>]` | Show and manage pipeline rows for a project — stages, blocked rows, manual recovery. Without an argument, derives project from your current git repo. |
| `/pipeline setup` | Conversational setup walkthrough — use instead of the TTY wizard when running inside Claude Code. Covers all 11 wizard steps interactively. |
| `/pipeline demo` | Narrated hands-on demo in a self-contained sandbox. Spins up a throwaway project + 4 plan files, walks rows through all stages on a ~10-minute timeline, narrates each transition while you watch the dashboard. Good for new users or showing the plugin to someone. |
| `/queue` | Queue a plan file for orchestration. |
| `/merge` | Squash-merge one or more tested branches to main. Invokes the `hooks.on_merge` hook if configured (hook owns the git operation when set). |

---

## Quick start

Run the interactive setup wizard:

```bash
node plugins/pipeline/bin/pipeline.mjs setup
```

The wizard walks through 11 steps:

| Step | What happens |
|------|--------------|
| 1/9 — Environment check | Runs `pipeline doctor` pre-flight; warns if any check fails and prompts to continue |
| 2/9 — Model defaults | Prompts for per-stage Claude model IDs (press Enter to keep defaults) |
| 3/9 — Review skill config | Sets the review slash-command and an optional extra-flag string |
| 4/9 — Slack channel | Optional `#channel` for failure/park notifications; blank to disable |
| 5/9 — Register first project | Adds the project name + absolute path to the unified DB |
| 6/9 — Autostart | Installs a platform scheduler entry so the orchestrator starts on login |
| 7/9 — PATH alias | Appends a `pipeline` function/alias to your shell profile |
| 8/9 — Smoke test | Re-runs `pipeline doctor` to confirm the environment is clean |
| 9/9 — Done | Prints the start command and exits |

Config is written atomically to `~/.pipeline/config.json` (mode 0o600).

---

## Notifications

The plugin is **notifier-agnostic**. Every notification and report is written as a JSON envelope to `~/.pipeline/notifications/<timestamp>-<slug>.json`. A separate forwarder turns those envelopes into messages on whatever channel you use.

### Envelope schema

```json
{
  "schema_version": 1,
  "timestamp":      "20260608T053253Z",
  "kind":           "notification",
  "title":          "Dev Handoff: subagent-investigation-skill",
  "priority":       "default",
  "body":           "<markdown body>",
  "source_file":    "<original report path, reports only>"
}
```

### Wiring a forwarder

Config key:

```json
{
  "hooks": {
    "on_notification": "/abs/path/to/forwarder.mjs"
  }
}
```

The hook is spawned once per envelope with the file path as its only argv. Stdio inherits.

> **Legacy:** `notifications.on_write` is still read as a fallback for one release cycle. Migrate to `hooks.on_notification` — `pipeline setup` does this automatically on the next run.

### Bundled Slack forwarder

The plugin ships `src/forwarders/claude-slack.mjs`. The setup wizard wires it as `hooks.on_notification` automatically when:

- A Slack channel is set (`notifications.governance_channel` or `notifications.pipeline_channel`)
- `claude-slack` is on PATH (installable via the `slack-bridge` plugin in this same marketplace)

Channel resolution: `pipeline_channel || governance_channel`. So pipeline events can go to a dedicated channel (e.g. `pipeline-events`) while general reports stay in your usual ops channel — keeps orchestrator pings out of curated channels.

### Bringing your own forwarder

Replace `hooks.on_notification` with your own executable — anything that takes a JSON envelope path and forwards it. Read `src/forwarders/claude-slack.mjs` as a 50-line reference implementation. Common patterns:

- **Different notifier** (Discord, MS Teams, email, webhook): substitute the underlying API call; the envelope format stays the same.
- **Routing**: parse `envelope.priority` or `envelope.title` to choose the destination channel.
- **Filtering**: skip envelopes you don't care about (e.g. only forward `priority: "high"`).

Setup never clobbers a non-bundled `on_notification` on re-run — once you point it at your own script, it stays yours.

---

## pipeline doctor

Checks that the runtime environment is ready. Tristate output: `✓` (pass), `⚠` (warn — runtime can start but a feature will silently no-op or you may be missing context), `✗` (fail — orchestrator cannot function). Exit code is 1 if any check fails; warns alone exit 0.

```bash
node plugins/pipeline/bin/pipeline.mjs doctor [--timeout <ms>]
```

`--timeout` controls the `claude --version` probe (default 5000ms).

| # | Check | Type | What it tests |
|---|-------|------|---------------|
| 1 | Node.js ≥ 22 | fail | `process.versions.node` major ≥ 22 (required for `node:sqlite`) |
| 2 | claude CLI | fail | `claude --version` exits 0 within `--timeout` |
| 3 | pipeline state dir | fail | `mkdirSync(paths.stateDir, { recursive: true })` succeeds |
| 4 | pipeline data dir | fail | `mkdirSync(paths.dataDir, { recursive: true })` succeeds |
| 5 | pipeline DB readable | warn | Open `<dataDir>/pipeline.db` and `SELECT 1` — warns if absent (fresh install); fails if corrupt/locked |
| 6 | config.json parseable | warn | Parse `~/.pipeline/config.json` if present — warns if absent (defaults apply); fails if malformed |
| 7 |  Governance channel set | warn | `notifications.governance_channel` is non-null — warns if null (intentional disable) |
| 8 | claude-slack on PATH | warn | `which claude-slack` resolves, OR `CLAUDE_SLACK_PLUGIN` env var points at an existing file — skipped if Slack disabled |
| 9 | orchestrator not running | warn | `~/.pipeline/orchestrator.state.json` does not show a live PID — warns informationally if already running |
| 10 | at least one project | warn | `projectList` returns ≥1 row — warns if zero (orchestrator would idle) |
| 11 | registered project paths | fail | Each registered project's `root_path` exists and contains `.git/` |

Exit codes: **0** — all checks pass or warn; **1** — one or more fail.

---

## Config schema

Written to `~/.pipeline/config.json` by `pipeline setup`. All keys are optional — missing keys fall back to `PIPELINE_DEFAULTS` in `src/config-defaults.mjs` at runtime.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `models.dev_default` | string | `"claude-haiku-4-5"` | Model used for dev sessions |
| `models.review_default` | string | `"claude-sonnet-4-6"` | Model used for review sessions |
| `models.governor` | string | `"claude-sonnet-4-6"` | Model used by the governor session (see "Governor and metrics" below) |
| `notifications.governance_channel` | string \| null | `null` | Slack channel name for governance reports + failure notifications (e.g. `"your-channel-name"`, without `#`); `null` disables |
| `notifications.pipeline_channel` | string \| null | `null` | Separate channel for per-row orchestrator events; falls back to `governance_channel` if null |
| `hooks.on_notification` | string \| null | `null` | Path to forwarder script — called once per envelope with the JSON file path as its only argv |
| `hooks.on_merge_ready` | string \| null | `null` | Path to hook script — called when a row reaches `stage=merge`; receives env vars (no argv) |
| `hooks.on_merge` | string \| null | `null` | Path to hook script — replaces the local squash merge when set; receives same env vars as `on_merge_ready`; hook owns the git operation |
| `hooks.merge_check` | string \| null | `null` | Path to hook script — invoked per `merge`-stage row each poll; exit 0 = "branch's PR is merged on the remote" → row advances to `done`. Sole mechanism for UI-merge detection (platform-agnostic) |
| `autoMerge` | boolean | `false` | When `true`, the orchestrator automatically spawns the merge agent for rows at `stage=merge` |
| `review.skill` | string | `"/code-review"` | Slash-command invoked by review sessions |
| `review.deep_flag` | string | `""` | Extra flag appended to the review skill invocation (any string; empty disables) |
| `devRetryBudget` | integer | `2` | Max times a dev session may retry after QA failure; per-feature override via `pipeline retry-budget-set` |

Example `~/.pipeline/config.json`:

```json
{
  "models": {
    "dev_default": "claude-haiku-4-5",
    "review_default": "claude-sonnet-4-6",
    "governor": "claude-sonnet-4-6"
  },
  "notifications": {
    "governance_channel": "your-ops-channel",
    "pipeline_channel": "your-pipeline-channel"
  },
  "hooks": {
    "on_notification": "/abs/path/to/forwarder.mjs",
    "on_merge_ready": "/abs/path/to/on-merge-ready.mjs"
  },
  "review": { "skill": "/code-review", "deep_flag": "" }
}
```

---

## Dashboard

Live observability + management UI. Two surfaces:

```bash
pipeline dashboard tui [--refresh-ms 10000]
pipeline dashboard web [--host 127.0.0.1] [--port 8765]
```

### Install

The dashboard uses [blessed](https://github.com/chjj/blessed) as a runtime dependency. The plugin includes a `package.json`, so before first use:

```bash
cd plugins/pipeline
npm install
```

(Subsequent `pipeline` commands work without re-running install.)

### TUI keybindings (Phase 1 — read-only)

| Key | Action |
|-----|--------|
| `q`, `Ctrl-C` | Quit |
| `r` | Force refresh now |
| `n` | Cycle to next registered project |
| `a` | Toggle show-done rows |
| `↑` / `↓` / `k` / `j` | Move row cursor |

Phase 2 will add the action menu (queue / delete / etc. via shell-out to existing CLI subcommands).

---

## Notifications + forwarder hook

The plugin is **notifier-agnostic**: every report and notification is written to a JSON envelope under `<pipeline-state-dir>/notifications/` (default `~/.pipeline/notifications/`). If `cfg.hooks.on_notification` is set to a command, the publisher spawns it with the envelope's file path as its only argument. The hook reads the JSON, picks what it needs, and forwards to whichever sink it wants — Slack, MS Teams, Discord, Pushover, email, webhook, log shipper, anything.

Out-of-the-box behaviour for a fresh install: notifications land on disk and nothing else happens. No external dependencies, no PATH lookups.

### Envelope schema (`schema_version: 1`)

```json
{
  "schema_version": 1,
  "timestamp":      "20260608T123456Z",
  "kind":           "notification" | "report",
  "title":          "<short title>",
  "priority":       "default" | "low" | "high",
  "body":           "<message body, may be markdown>",
  "source_file":    "<original report path>"   // reports only
}
```

### Sample hook (any language; the file path is its only argv)

```bash
#!/bin/bash
ENVELOPE=$1
TITLE=$(jq -r .title    "$ENVELOPE")
BODY=$(jq -r .body      "$ENVELOPE")
PRIORITY=$(jq -r .priority "$ENVELOPE")
# Forward however you like — e.g. MS Teams:
curl -X POST -H 'Content-Type: application/json' \
  -d "{\"title\": \"$TITLE\", \"text\": \"$BODY\"}" \
  "$TEAMS_WEBHOOK_URL"
```

Wire it via `~/.pipeline/config.json`:

```json
{ "hooks": { "on_notification": "/abs/path/to/forwarder.sh" } }
```

Hooks ending in `.mjs` / `.js` are auto-prefixed with `node`; everything else is exec'd directly. The hook's stdout/stderr inherit so failures are visible.

### on_merge hook

Fires at the point of merge — invoked by `merge.mjs` (step 5) for each branch being squash-merged. When set, **the hook is the single merge authority**: `merge.mjs` skips its local squash-merge and delegates the entire git operation to the hook. A non-zero exit code aborts the merge with an error.

```json
{ "hooks": { "on_merge": "/abs/path/to/hook.mjs" } }
```

The hook receives the same four environment variables as `on_merge_ready`:

| Variable | Value |
|----------|-------|
| `PIPELINE_PROJECT` | Project name |
| `PIPELINE_FEATURE` | Feature slug |
| `PIPELINE_BRANCH` | Full branch name **or bare slug** — the hook normalises to `autonomous/<slug>` |
| `PIPELINE_TARGET_BRANCH` | Merge target |

**Single-authority contract:** `merge.mjs` performs either (a) a local squash-merge *or* (b) delegates to `on_merge` — never both. When the hook is configured:

1. `merge.mjs` checks whether the branch has any commits ahead of the target. If already integrated (0 ahead), it fast-forwards local target to `origin/<target>` and skips the hook.
2. If there are commits to merge, `merge.mjs` invokes the hook. The hook does `gh pr merge --squash` on origin.
3. After the hook exits successfully, `merge.mjs` fast-forwards local target to `origin/<target>` so `local == origin` and the next merge starts clean.

This prevents the double-squash problem where a local commit and an origin GitHub commit diverge after the merge.

**Enriched squash commit message (bundled template):** the bundled `on-merge.mjs` template (see `src/setup/wizard-hooks.mjs`) builds a richer squash commit than GitHub's default:

1. Calls `row-get <project> <feature>` to read `pr_title`, `d_model`, and `target_branch` in a single DB call.
2. Checks if the PR is already `MERGED` via `gh pr view` — skips the merge and fast-forwards local target if so (already-merged guard).
3. Runs `git diff <target>...<branch> --stat --no-color` and passes the output to `claude -p` (Haiku, temperature=0) to generate a 2-3 bullet plain-text commit body.
4. Appends a `Co-Authored-By: <Model Display Name> <noreply@anthropic.com>` trailer using the `d_model` from the DB row.
5. Calls `gh pr merge --squash --subject <pr_title> --body <bullets+trailer>` using the fully-qualified branch ref (`autonomous/<slug>`).
6. Fast-forwards local target to `origin/<target>` after a successful GitHub merge.

If `pr_title` is empty (old rows), the feature slug is used as the subject — identical to GitHub's default. If `claude -p` fails or times out, the body falls back to the trailer alone.

**Relationship to `autoMerge`:** when `autoMerge: true`, the orchestrator calls `spawnMerge` which runs `merge.mjs` — so `on_merge` fires for autoMerge-triggered merges too, not just manual `/merge` invocations.

---

### on_merge_ready hook

Fires whenever a pipeline row reaches `stage=merge`. **Gated by `autoMerge`:** when `autoMerge: false` (the default), the bundled `on-merge-ready.mjs` template exits immediately without pushing or creating a PR — automatic PR creation is opt-in. Set `"autoMerge": true` in `~/.pipeline/config.json` to enable it. Common uses when enabled: push the branch, open a GitHub PR, post a Slack ping.

```json
{ "hooks": { "on_merge_ready": "/abs/path/to/hook.mjs" } }
```

The hook receives four environment variables — no argv:

| Variable | Value |
|----------|-------|
| `PIPELINE_PROJECT` | Project name (e.g. `my-app`) |
| `PIPELINE_FEATURE` | Feature slug (e.g. `fix-login-bug`) |
| `PIPELINE_BRANCH` | Full branch name (e.g. `autonomous/fix-login-bug`) |
| `PIPELINE_TARGET_BRANCH` | Merge target (e.g. `master`) |

The hook has a 15-second hard timeout; its exit code is ignored (fire-and-forget).

#### Row Data

The `pr_title` column is populated at queue time from `queue-plan`'s `--title` flag, falling back to the plan's `*Title:* <text>*` annotation. Use `row-get` to retrieve the full row (including `pr_title`, `d_model`, `target_branch`) in a single call:

```js
const rowResult = spawnSync(pipelineBin, ["row-get", project, feature], { encoding: "utf8" });
let row = {};
try { row = JSON.parse(rowResult.stdout?.trim() || "{}"); } catch {}
const title = row.pr_title || feature;  // fall back to slug if empty
```

`pipeline setup` asks whether to configure `on_merge_ready` and can write a Slack wrapper to `~/.pipeline/hooks/on-merge-ready.mjs` automatically if `hooks.on_notification` is already pointing at the bundled claude-slack forwarder.

---

### merge_check hook

Closes the loop when a PR is merged in the platform UI rather than through `/merge`. Without it, the orchestrator has no UI-merge detection — a PR merged on the platform side leaves its row parked at `stage=merge` until `/merge` or `pipeline done` runs.

```json
{ "hooks": { "merge_check": "~/.pipeline/hooks/merge-check.mjs" } }
```

Each orchestrator poll invokes the hook once per `merge`-stage row with the standard merge-hook env contract (`PIPELINE_PROJECT`, `PIPELINE_FEATURE`, `PIPELINE_BRANCH`, `PIPELINE_TARGET_BRANCH`, `PIPELINE_PROJECT_ROOT`, `PLUGIN_DIR`) and a 20-second timeout. Exit 0 means "this branch's PR is merged on the remote" — the row advances to `done` and its progress entries are cleaned up. Any other exit (or timeout) means not merged; the row is left alone and re-checked next poll.

A Bitbucket implementation is a ~40-line script: query `GET /2.0/repositories/<ws>/<repo>/pullrequests?q=source.branch.name="<branch>" AND state="MERGED"` and exit 0 when the result is non-empty. A GitHub implementation can shell out to `gh pr view <branch> --json state` and check for `"MERGED"`.

---

## Path resolution

Every config-driven path key in the plugin is resolved through one helper:
`resolveTemplate(template, vars, { resolveBase, configDir })` in
`src/worktree-paths.mjs`. The rule:

1. Substitute `{placeholder}` tokens from `vars`; unknown placeholders pass through literally. `{config_dir}` is filled from the `configDir` option.
2. Expand a leading `~/` to `os.homedir()`.
3. If the result is absolute (POSIX `/...`, drive letter `C:\...`, UNC `\\server\share`), use verbatim. Otherwise resolve against `resolveBase`.

### resolveBase categories

| Category | `resolveBase` | Keys |
|---|---|---|
| Per-project          | `projectRoot` | `plansDir`, `governor.reports_dir`, `governor.session_dir`, `governor.log_dir`, `worktree_base` *(future)* |
| Global / install-wide | `paths.configDir` | `notifications.fallback_dir`, `session_templates_dir`, `hooks.on_notification`, `hooks.on_merge_ready`, `hooks.on_merge`, `hooks.merge_check`, `governor.template_path` |
| Within-worktree       | resolved `featureWorktreePath(...)` | `report_subpath` |

`paths.configDir` is `~/.pipeline` on Mac/Windows and `$XDG_CONFIG_HOME/pipeline` (fallback `~/.config/pipeline`) on Linux.

Hook values are command strings — only the first whitespace-separated token is routed through `resolveTemplate`; trailing argv passes through unchanged.

### Placeholder vocabulary

| Placeholder | Source |
|---|---|
| `{root}`             | `projectRoot` |
| `{root_parent}`      | `dirname(projectRoot)` |
| `{root_grandparent}` | `dirname(dirname(projectRoot))` |
| `{project}`          | project name (or `basename(projectRoot)`) |
| `{feature}`          | row feature / plan stem |
| `{kind}`             | `code-review` / `qa-test` |
| `{branch}`           | full branch name |
| `{branch_type}`      | first slash-segment of branch |
| `{branch_local}`     | branch minus the first slash-segment |
| `{config_dir}`       | `paths.configDir` |

The canonical exported list is `PLACEHOLDER_KEYS` in `src/worktree-paths.mjs`; a test pins this table to that constant so the two cannot drift.

### Helpers

`src/worktree-paths.mjs` exposes three feature-aware wrappers over `resolveTemplate`:

| Helper | Template key | Default | Notes |
|---|---|---|---|
| `featureWorktreePath({ project, projectRoot, feature })` | `cfg.worktree_base` | `{root_parent}/.worktrees/{project}/{feature}` | Phase 3b canonical per-feature worktree — one worktree shared across dev / research / review / test / merge. Branch-context placeholders substitute to `""` when called without one. |
| `orchestratorWorktreePath({ project, projectRoot, branch })` | `cfg.orchestrator_worktree_base` | `{root_parent}/{project}-wt/{branch_type}-{branch_local}` | Deprecated compat wrapper (emits one-shot `console.warn`). Retained only so `tests/worktree-paths.test.mjs` can pin pre-3b parity; production callers must use `featureWorktreePath`. |
| `handlerWorktreePath({ project, projectRoot, kind, feature })` | `cfg.handler_worktree_base` | `{root_parent}/.worktrees/{kind}-{feature}` | Deprecated compat wrapper (emits one-shot `console.warn`). Retained for the same reason; do not introduce new call sites. |

All three flow through `resolveTemplate` with `resolveBase = projectRoot`, so the placeholder vocabulary, `~/` expansion, and absolute-vs-relative classification are identical across them.

### Locators

Resolution chains for external binaries (e.g. claude-slack) live under `src/locators/` and return `{ path, source }`. Wizard and doctor both consume the locator — never duplicate the chain inline.

---

## Worktree paths

The orchestrator creates one worktree per pipeline-row branch. Operator-managed worktrees for QA tests and code-review verdicts live in separate locations and are handled by the `pipeline test-complete` and `pipeline review-complete` subcommands. Both paths are template-driven via config:

| Config key | Default | What it resolves to |
|---|---|---|
| `orchestrator_worktree_base` | `{root_parent}/{project}-wt/{branch_type}-{branch_local}` | The worktree the orchestrator creates for an `autonomous/<plan-stem>` (etc.) branch |
| `handler_worktree_base` | `{root_parent}/.worktrees/{kind}-{feature}` | The qa-test / code-review worktree the operator manages by hand |

Placeholders:

| Placeholder | Resolves to |
|---|---|
| `{root}` | Registered project's `root_path` (absolute) |
| `{root_parent}` | `dirname(root_path)` |
| `{project}` | Registered project name (falls back to `basename(root_path)` if unset) |
| `{branch}` | Full branch name (orchestrator only), e.g. `autonomous/foo` |
| `{branch_type}` | First slash-segment of branch (orchestrator only), e.g. `autonomous` |
| `{branch_local}` | Branch name with first slash-segment stripped (orchestrator only), e.g. `foo` |
| `{kind}` | `qa-test` or `code-review` (handler only) |
| `{feature}` | Pipeline-row feature slug (handler only) |

Override a template with an absolute path to ignore `{root_parent}`. Example override that pins all handler-style worktrees to a single shared directory regardless of project:

```json
{ "handler_worktree_base": "/Users/me/work/wt/{kind}-{feature}" }
```

---

## Queueing a plan

A **plan** is a markdown file describing what to build. The pipeline doesn't care how the plan got written — Claude Code's built-in Plan agent, your own workflow, a hand-typed file, whatever. Once it's on disk, you queue it and the orchestrator takes over.

### The simplest path (in Claude Code)

```
/queue path/to/my-plan.md
```

This invokes the `/queue` skill, which:
1. Resolves the project from your current git repo (`git rev-parse --show-toplevel` → basename → project name).
2. Verifies the project is registered (`pipeline project-list`).
3. Resolves the plan-file path (see resolution rules below).
4. Runs `pipeline queue-plan <project> <abs-path> --type dev` for you.
5. Reports the row + tells you where to watch.

Defaults to `dev` session type. For other types:

```
/queue path/to/my-plan.md research
/queue path/to/my-plan.md review
/queue path/to/my-plan.md test
```

### What goes in a plan file

Bare minimum: a markdown file with a heading and what needs doing. The orchestrator passes the **full plan content** to the spawned session as `{{PLAN_CONTENT}}`, so write it for the agent that will execute it — clear scope, file paths, acceptance criteria.

Optional plan annotations the pipeline understands:

```markdown
# add dark mode toggle

*Branch: `autonomous/dark-mode`*
*Title:* Add dark mode toggle
*Prerequisites:* `autonomous/theme-context-refactor`

## Scope
- preference toggle in settings
- persist to localStorage
- fall back to prefers-color-scheme
```

| Annotation | What it does |
|------------|--------------|
| `*Branch: \`<name>\`*` | Branch the orchestrator's worktree gets. Accepts **any** branch name (any prefix), not only `autonomous/`/`interactive/`. Default: `autonomous/<plan-stem>`. The session never commits to the target branch — see Failure handling. |
| `*Target-Branch: <name>*` | Branch the merge layer merges into. Default: `main`. |
| `*Prerequisites:* \`autonomous/<slug>\`` | Row holds until each named prerequisite row is `done` (**soft**, the default). Comma-separate multiple slugs. Prefix a token with `!` for **strict** (`done` **and** its branch is an ancestor of the target) — at most one `!` per plan (maps to `waits_on`). A `project:feature` token is cross-project and always soft; `!project:feature` is rejected. Omit the line entirely when there are no dependencies. |
| `*Type:* <dev\|research\|review\|test>` | Session type for this plan. Optional for a single `queue-plan` (the `--type` flag wins, else this, else `dev`); **required on every plan when clustering**. |
| `*Research-Model:* / *Dev-Model:* / *QA-Model:* / *Review-Model:* <model>` | Per-kind model pin. The matching `--r/d/q/rvw-model` flag wins, else this annotation, else the configured default. |

CLI flags override annotations — useful for one-off overrides without editing the plan.

### Plan-file path resolution

```bash
pipeline queue-plan <project> <plan-file-path> \
  [--branch <name>] [--depends <slug,...>] [--target-branch <name>] \
  [--type dev|research|review|test] [--r-model …] [--d-model …]
```

The plan-file path can be:

1. **Absolute** — used as-is.
2. **Relative with a slash** — resolved against the cwd.
3. **Bare filename** — resolved under the project's plans directory (see precedence below).

Whatever resolution wins, the **absolute path** is stored on the row. Every downstream consumer (session-gen, orchestrator, merge) reads it from there — no re-resolution, no convention drift.

**Plans-directory precedence** (used by `resolvePlansDir()` in `src/plans-resolver.mjs`; every consumer routes through this helper — no second implementation):

1. `cfg.plansDirs[<project>]` from `~/.pipeline/config.json` — a map of project name to template string. Set via `pipeline project-add --plans-dir <path>` or `project-update --plans-dir <path>`. The full placeholder vocabulary is honoured. Wins per-project.
2. Project row's `plans_dir` column (legacy; pre-`plansDirs` installs). Cleared on every `project-update`; new writes go to the config map. Still read for backward compatibility.
3. `cfg.plansDir` from `~/.pipeline/config.json` — a template substituted through `resolveTemplate`.
4. `<projectRoot>/plans` — historical default.

`resolvePlanFile(planFile, opts)` resolves a single filename: absolute paths pass through; bare filenames join under the resolved plans directory.

### Session types

| Type | When to use | Stage on queue |
|------|-------------|---------------|
| `dev` (default) | You have a plan, want it implemented + tested | `queued` → `dev` |
| `research` | You want investigation + a refined plan written before any code | `queued` → `research` |
| `review` | The work is done elsewhere (e.g. an external PR), you just want a code review | `queued` → `review` |
| `test` | Reserved — not picked up by the orchestrator today (see "Session types" below) |

A research row can hand off to a dev row via `pipeline research-complete <project> <research-feature> <dev-feature> <dev-plan>`, chaining the lifecycle.

### What happens after queue

- Row lands in the DB at the stage you queued for (default `queued`).
- Orchestrator polls (default every 2s) and picks it up if no deps block it.
- Worktree is created at `{root_parent}/{project}-wt/autonomous-{plan-stem}` (overridable, see "Worktree paths").
- `claude -p` is spawned with the session file (generated from the bundled template + your plan content).
- Stage advances on session exit; reaper auto-requeues on transient failures (capped by `dev_retries`).
- Watch progress in `pipeline dashboard tui` / `pipeline dashboard web` or via `/pipeline`.

---

## Target branch handling

`queue-plan` resolves a row's `target_branch` via this precedence chain — first hit wins:

1. Row's `target_branch` column (set explicitly at queue time / admin override).
2. Operator's `--target-branch` flag on `queue-plan`.
3. Plan file's `*Target-Branch: <name>*` annotation.
4. `detectDefaultBranch(projectRoot)` — `git symbolic-ref refs/remotes/origin/HEAD`, then `git config init.defaultBranch`.
5. `DEFAULT_TARGET_BRANCH_FALLBACK` (`"main"`, exported from `src/cli/helpers.mjs`).

Once a row has `target_branch` stored, the column wins — the chain only runs at queue time. Hardcoded `"master"` is a defect; route through `detectDefaultBranch` instead.

`warnUnrecognisedTargetPrefix` emits a one-line warning (not error) when the resolved target carries a prefix not in `cfg.recognised_branch_types` (default `["autonomous", "interactive"]`). `lintTargetBranchProse` is the separate check that errors when plan prose mentions a target branch without an annotation.

Below: the three mechanical guards applied during extraction/validation.

### Parser robustness

`*Target-Branch: <value>*` annotations are parsed with surrounding asterisks and whitespace stripped from the captured value before storage. This prevents markdown italic-formatting artifacts from being stored as malformed branch names.

### Validation gate

Before a row is inserted, `target_branch` is validated with `git check-ref-format --branch`. Malformed values (e.g., branch names with spaces or invalid characters) are rejected at queue time with a clear error message.

### Prose-without-annotation lint

When queueing a plan with no `*Target-Branch:` annotation, the plan body is scanned for prose patterns suggesting a non-main branch was intended:
- Substring `feature/` (case-sensitive)
- Pattern `target.{0,5}branch` (case-insensitive)
- Backticked branch references containing `feature/`

If a suspicious match is found, queueing fails with an error pointing at the offending line. Resolve by either adding the annotation or passing `--target-branch main` explicitly to confirm intent.

---

## Merge layer

`skills/merge/merge.mjs` runs the squash-merge pipeline: rebase → verify DoD → squash merge → move plans → project commit → smoke check. Invoked by the `/merge` skill:

```bash
node plugins/pipeline/skills/merge/merge.mjs \
  --branches autonomous/feat-a,autonomous/feat-b \
  --project-dir /path/to/project \
  [--plans-dir /path/to/plans] \
  [--target-branch main] \
  [--session-slug merge_20260608-1430] \
  [--skip-smoke] [--skip-testing] [--dry-run]
```

Plan file paths are read from the pipeline DB row (stored at queue time). `--plans-dir` is used only as a fallback for rows that predate DB-stored paths. Default: `<project-dir>/plans/`.

**Config:**

| Key | Default | Purpose |
|---|---|---|
| `plansDir` | `"plans"` | Where plan files live, relative to project root. Supports the standard placeholder vocabulary (`{root}`, `{root_parent}`, `{root_grandparent}`, `{project}`). |
| `plansDirs` | `{}` | Per-project overrides keyed by project name (e.g. `{"my-project": "../shared/plans/{project}"}`). Same placeholder vocabulary as `plansDir`. Wins over `plansDir` for that project only. Written by `pipeline project-add --plans-dir <path>` / `project-update --plans-dir <path>`. |

---

## Quality gates

| Transition | Gate | Enforced by |
|------------|------|-------------|
| research → queued(dev) | Plan written + no `[BLOCKER]` + session complete | Research session |
| dev → queued(test) | Unconditional | Dev session |
| test → merge | All tests pass + no manual steps | Test session |
| test → manual | All tests pass + manual steps identified | Test session |
| manual → merge | Human confirms physical steps done | Human via `/pipeline done` |
| any → main | All plan items `✓` + QA Pass = `true` + stage = `merge` | `/merge` (hard stop on failure) |

### DoD — plan-files check (`verifyPlanFilesInDiff`)

`/merge` cross-checks every path listed under `## Files Changed` in the plan against the squash diff. A claimed path that does not appear in the diff causes a hard stop.

**External paths are skipped automatically.** A path is considered external when it:

- Starts with `~/`, `$HOME/`, or `${HOME}/` (operator HOME — hooks, global skills, config files)
- Is an absolute path that resolves outside the project tree (a `C:/` or `/` prefix that `normalizePlanPath` cannot strip because the project name is absent from the segments)

For each skipped external path the merge runner emits:

```
WARN: [external-skip] <path> — not in squash diff (outside project tree)
```

The merge continues; the operator is responsible for confirming those files were updated on disk. External paths should **not** be listed under `--skip-testing` — that flag silences `(needs testing)` items and has a wider blast radius.

---

## Failure handling

| Failure | Result |
|---------|--------|
| Dev session exits non-zero | Stage stays `dev`; no test session spawned; notification sent |
| Test session exits non-zero | Partial report written; QA Pass set to `false`; notification sent |
| Orchestrator spawn fails | Stage reverted to `queued`; `[spawn-failed]` in notes; notification sent |
| Resolved branch equals the target/default branch | Spawn refused before launch; row parked at `manual` with `[branch-equals-target]`; notification sent (never commits to the merge destination) |
| Research produces no plan | No chain; human notified |
| Research has `[BLOCKER]` | No chain; notification names the blocking question |
| `/merge` — QA Pass is not `true` | Hard stop; merge refused |
| `/merge` — stage is `manual` | Hard stop; run `/pipeline done` first |

### Merge recovery — orphaned state

The merge runner rolls back on abort. If state persists after a merge failure, recover manually:

```bash
# Orphaned progress entry
pipeline progress-delete <mem-dir> <slug>

# Stale worktree
git worktree remove --force <path>

# Stale branch
git branch -D <branch>

# Pipeline row stuck at merge stage
pipeline stage-set <project-root> <slug> done
```

Re-running `/merge <branch>` after cleanup picks up where it left off — progress entries are idempotent and the runner detects already-integrated branches.

---

## What cannot be automated

| Step | Reason |
|------|--------|
| test → manual | Physical interaction with a running process required |
| manual → merge | Human must confirm physical steps completed |
| Documentation review in `/merge` | Judgment required |
| Research quality (partially) | `[BLOCKER]` check is mechanical; plan quality relies on session judgment |

---

## Session templates

The orchestrator spawns each session against a markdown template bundled with the plugin: `dev-session.md`, `review-session.md`, `test-session.md`, `research-session.md`, `governor-session.md`. Templates live in `plugins/pipeline/templates/` and contain `{{...}}` placeholders that `session-gen.mjs` expands at queue time. The generated session file lands in `<project-root>/sessions/<type>-<date>-<plan-stem>.md`.

To override with your own templates, point `session_templates_dir` at a directory:

```json
{ "session_templates_dir": "/absolute/path/to/my-templates" }
```

The plugin falls back to the bundled template for any file your directory doesn't carry — so you can override just `dev-session.md` and inherit the rest.

Placeholders the templates may reference:

| Placeholder | Source |
|---|---|
| `{{SESSION_TYPE}}` | `dev` / `research` / `review` / `test` / `governor` |
| `{{PROJECT}}` | Registered project name |
| `{{PROJECT_ROOT}}` | Project's `root_path` (absolute) |
| `{{FEATURE}}` | Pipeline-row feature slug |
| `{{PLAN_PATH}}` | Absolute path to the plan file |
| `{{PLAN_CONTENT}}` | Full text of the plan file |
| `{{CORRELATION_ID}}` | Session slug (`<type>-<date>-<plan-stem>`) — stable per session file |
| `{{BRANCH}}` | Branch name (e.g. `autonomous/feat-x`) |
| `{{TARGET_BRANCH}}` | Merge target (default `main`) |
| `{{CWD}}` | Worktree path the session runs in |
| `{{REVIEW_SKILL}}` | `review.skill` + `review.deep_flag` joined and trimmed |

Unknown placeholders are left untouched in output so missed substitutions are visible.

---

## Hooks

### UserPromptSubmit hook registration

The pipeline plugin wires a `UserPromptSubmit` hook into Claude Code that fires on every user prompt. This hook is registered in `plugins/pipeline/hooks/hooks.json` and dispatches to a Node.js script via the polyglot wrapper.

**Registration schema (`hooks.json`):**
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" user-prompt-submit",
            "async": false
          }
        ]
      }
    ]
  }
}
```

**Implementation path:** `plugins/pipeline/hooks/user-prompt-submit` (bash shim) → `plugins/pipeline/src/hooks/user-prompt-submit.mjs` (Node.js)

### Dual-writer phase (phases 2–4)

During the `pipeline-absorb-claude-db` migration phases 2–4, two hooks fire on every prompt:
1. **Python hook** (`<claude-base>/scripts/session_user_submit_hook.py`) — writes to `<claude-base>/claude.db` (legacy)
2. **mjs hook** (pipeline plugin) — writes to `~/.pipeline/pipeline.db` (new)

Both hooks inject identical `additionalContext` to Claude Code. This dual-writer state ensures:
- Real production traffic feeds `pipeline.db.claude_sessions` without depending on a backfill
- The new hook is soaked against the Python hook as a safety net before phase 3 retires the reader dependencies
- Phase 4 can retire the Python hook with confidence

**To remove the Python hook (phase 4 operation):** Delete the following entry from **both**:
- `~/.claude/settings.json`
- `<claude-base>/settings.json`

Entry to remove:
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "command": "python ${CLAUDE_HOME}/scripts/session_user_submit_hook.py",
        "async": false
      }
    ]
  }
}
```

(Only the `pipeline@marketplace` entry remains.)

### Hook logging

The mjs hook appends one line per invocation to `~/.pipeline/logs/user-prompt-submit.log`:
```
<iso-timestamp> <session-id> <cwd> <keepalive> <transcript-size> <prev-any-ts> <injected-templates>
```

On error, appends:
```
<iso-timestamp> Error: <stack-trace>
```

No rotation — operator truncates manually if needed during the soak phase; phase 5 retirement removes the log entirely.

### Template-file divergence from Python hook

The Python hook crashes on missing template files. The mjs hook wraps each template read in try/catch and falls back to empty string if missing. This divergence is intentional for robustness — template files live outside the plugin tree and may not exist on all user machines.

**Affected templates:**
- `~/.claude/templates/session-context.md`
- `~/.claude/templates/compact-resume.md`
- `~/.claude/templates/session-checkpoint.md`

If any template is missing, its section is skipped but the hook still emits valid JSON stdout.

### Hooks pattern for future plugins

The bash shim pattern (`plugins/pipeline/hooks/user-prompt-submit` → `plugins/pipeline/src/hooks/user-prompt-submit.mjs`) is the new standard for plugin hooks. Slack-bridge's `session-start` hook does all its work inline in bash; for larger logic (session DB upserts, checkpoint triggers, multiple template reads), this dispatch pattern is cleaner. New plugin hooks should follow it:

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "${SCRIPT_DIR}/../src/hooks/hook-name.mjs" "$@"
```

---

## Session types

The orchestrator supports four session types: `dev`, `research`, `review`, `test`. They share one worktree per pipeline row (git semantics: one branch → one worktree).

**`test` is bypassed in practice.** Orchestrator-spawned test sessions have proven low-value to date. The type stays in the schema so it can be re-enabled later — for example, having a test session write scratch tests to pull on threads surfaced by dev. For now, treat the test stage as a manual gate the operator advances.

### Session completion behaviour

**Research** — runs a quality gate, then hands off (non-blocking):
- Must have written at least one plan file
- No `[BLOCKER]` in any produced plan's Open Questions
- All progress items complete

If gate passes: sets pipeline row to `queued` with `type=dev`, notifies, and exits. Orchestrator spawns the dev session on the next poll cycle. If gate fails: notifies and does not chain.

**Dev** — before generating the test session, closes all documentation gaps: flips `(needs testing)` items to `✓` in the plan, removes resolved Open Questions, updates affected docs. Then sets pipeline row to `queued` with `type=test` and exits.

**Test** — updates the DB based on outcome:
- All pass, no manual steps → stage `merge`, QA Pass `true`
- All pass, manual steps needed → stage `manual`, QA Pass `true`, description in notes
- Failures → stage stays `test`, QA Pass `false`

---

## Governor and metrics — future direction

The plugin currently bundles a `governor` scheduler, a metrics CLI under `src/metrics/`, and the spend / baseline / anomaly / governor-spawn tables in `pipeline.db`. The governor runs scheduled background sessions that produce daily and monthly governance reports; the metrics CLI rolls up session-level analytics for those reports.

These features **work today** when configured (see the `governor` config block below) — they're not stubs. But they're conceptually separate from pipelining: they're observability, not autonomous dev orchestration.

**Interim:** they ship in this plugin because the orchestrator already has the wiring. **Long-term:** extract into a separate plugin that depends on this one, or rework the orchestrator to provide generic hooks so observability can plug in however the user wants. Until that work happens, treat the governor + metrics surface as **carried-along** — present, runnable, but not the plugin's core promise.

Governor config:

```json
{
  "governor": {
    "enabled":       false,
    "project":       null,
    "template_path": null,
    "reports_dir":   null,
    "session_dir":   null,
    "log_dir":       null
  }
}
```

| Key | Default | Purpose |
|---|---|---|
| `governor.enabled` | `false` | Master switch — orchestrator skips governor spawns when false |
| `governor.project` | `null` | Registered project name to attribute governor sessions to (`pipeline project-add` first) |
| `governor.template_path` | `null` → bundled | Override path for `governor-session.md`. Bundled template ships in `plugins/pipeline/templates/`. |
| `governor.reports_dir` | `<projectRoot>/reports/` | Where the session writes `governance-<date>.md` / `status-<date>.md`. Used by the rate-limit check. |
| `governor.session_dir` | `<projectRoot>/sessions/` | Where the orchestrator writes generated `gov-<ts>.md` session files |
| `governor.log_dir` | `<projectRoot>/logs/` | Where the spawned governor process redirects stdout/stderr |

---

## Autostart

The wizard installs a persistent background entry so the orchestrator process starts on login.

| Platform | Mechanism | Entry location |
|----------|-----------|---------------|
| Windows | Windows Task Scheduler (`schtasks`) | `ClaudePipelineOrchestrator` task |
| macOS | launchd plist | `~/Library/LaunchAgents/com.claudepipeline.orchestrator.plist` |
| Linux | systemd user service | `~/.config/systemd/user/claude-pipeline.service` |

To install or reinstall autostart outside the wizard, re-run setup and choose Y at the autostart prompt:

```bash
node plugins/pipeline/bin/pipeline.mjs setup
```

---

## PATH alias

The wizard appends a `pipeline` entry to your shell profile so you can run `pipeline <subcommand>` directly.

**Windows — PowerShell profile (`$PROFILE`)**

```powershell
function pipeline { & "C:\path\to\node.exe" "C:\path\to\plugins\pipeline\bin\pipeline.mjs" @args }
```

Reload: `. $PROFILE`

**macOS / Linux — bash or zsh**

```bash
alias pipeline='/path/to/node /path/to/plugins/pipeline/bin/pipeline.mjs'
```

Reload: `source ~/.zshrc` (or `~/.bashrc`)

---

## Run commands

```bash
# Interactive setup wizard
node plugins/pipeline/bin/pipeline.mjs setup

# Environment pre-flight checks
node plugins/pipeline/bin/pipeline.mjs doctor

# Run the full test suite
cd plugins/pipeline && npm test
```

---

## Subcommand reference

### Setup

| Subcommand | Purpose |
|------------|---------|
| `setup` | Interactive wizard — configure models, Slack, autostart, and PATH alias |
| `doctor` | Pre-flight checks: Node version, claude CLI, claudeBase, repos/, state dir |

### Pipeline rows

| Subcommand | Purpose |
|------------|---------|
| `stage-set <root> <feature> <stage>` | Set a pipeline row's stage |
| `stage-get <root> <feature>` | Get current stage for a feature |
| `row-add <root> <feature> <plan-file> <stage>` | Add a new pipeline row |
| `rows <root> [--format json\|plain\|md]` | List all rows |
| `row-delete <root> <feature>` | Remove a pipeline row |
| `retry-budget-set <root> <feature> <budget>` | Set the max dev retry budget for a feature (overrides config default) |
| `done <root> <feature>` | Mark a feature complete (only valid from `manual` stage — `stage-set … done` works from any stage, but directly advancing a non-manual row to done is unusual and skips all quality gates) |
| `cycle-log <project> [--feature <slug>] [--limit N] [--format json\|plain]` | Per-session timing + spend + outcome log (one row per finished session) |
| `next-actions <root>` | Show what the orchestrator would act on next |
| `dev-complete <project> <plan-file> <feature> --pipeline <path>` | Advance dev → review |
| `test-complete <project> <feature> --pipeline <path>` | Advance test stage |
| `review-complete <root> <feature> --report <path> --verdict <v>` | Advance review |
| `research-complete <root> <rf> <df> <dp>` | Advance research → dev |

### Progress

| Subcommand | Purpose |
|------------|---------|
| `progress-create <mem-dir> <slug> [--steps ...]` | Create a progress file |
| `progress-get <mem-dir> <slug> [--format md\|json\|tasks]` | Get progress content |
| `progress-mark <mem-dir> <slug> <step> <state>` | Mark a step in-progress or done |
| `progress-delete <mem-dir> <slug>` | Delete a progress file |
| `progress-list-active <mem-dir>` | List active in-flight progress files |
| `progress-note <mem-dir> <slug> <text>` | Append a timestamped note |
| `progress-set-pid <mem-dir> <slug> <pid>` | Record the session PID |

### Queue

| Subcommand | Purpose |
|------------|---------|
| `queue-plan <root> <plan-file>` | Queue a plan for orchestration (`--waits-on`, `--base-branch` for chaining) |
| `queue-cluster <root> <plan-file>...` | Queue a dependency-chained set of plans in one shot; wires `waits_on` + `base_branch` from each plan's `*Prerequisites:*` |
| `queue-name-derive <brief>` | Derive a slug from a description |
| `queue-branch-extract <plan-file>` | Extract branch from plan frontmatter |
| `queue-title-extract <plan-file>` | Extract PR title from plan's `*Title:*` annotation |

### Other

| Subcommand | Purpose |
|------------|---------|
| `notify --title <t> --message <m>` | Publish a notification envelope (forwarded if `hooks.on_notification` is set) |
| `session-generate <project> <plan-file> <type>` | Generate a session file from template |
| `row-get <project> <feature>` | Read the full row as JSON — includes `pr_title`, `d_model`, `target_branch`, and all other fields. Preferred over the piecemeal column commands in hook scripts. |
| `target-branch-get <root> <feature>` | Read the target_branch for a row (deprecated — use `row-get`) |
| `pr-title-get <root> <feature>` | Read the pr_title for a row (deprecated — use `row-get`) |

---

## Architecture

```
plugins/pipeline/
  bin/pipeline.mjs          CLI entry point
  src/
    setup/
      wizard.mjs            Interactive setup wizard (8 steps)
      doctor.mjs            Environment pre-flight checks
      autostart.mjs         Platform autostart install/verify
    config.mjs              Config loader with env-override layer
    config-defaults.mjs     PIPELINE_DEFAULTS (models, notifications, review)
    pipeline-config.mjs     Merged config resolver
    paths.mjs               Platform-appropriate state/log dirs (~/.pipeline/)
  scripts/
    pipeline-db/            SQLite access layer
      connection.mjs        DB open + single folded migration (Node 22 node:sqlite)
      rows.mjs              Pipeline row CRUD + CAS requeue
      progress.mjs          Progress file tracking
      sessions.mjs          Session spawn/finish tracking
      state.mjs             KV state tables
      analytics.mjs         Spend, spawn map, governor spawns
    orchestrator/           Queue polling orchestrator
      index.mjs             Main poll loop + startup/shutdown
      spawn.mjs             Worktree creation + claude -p spawn
      reaper.mjs            Process exit handling + auto-requeue
      governor.mjs          Governor scheduler — daily + monthly governance sessions (see "Governor and metrics")
      discovery.mjs         Project discovery (pipeline_enabled flag)
      state-file.mjs        Orchestrator state file (~/.pipeline/orchestrator.state.json)
    session-gen.mjs         Session file template engine
    publisher.mjs           Envelope writer + on_notification / on_merge_ready hook dispatcher
    merge/                  Branch merge helpers
    metrics/                Spend analytics + governance reporting (carried-along surface — see "Governor and metrics")
```

---

## Feature dependencies

Features can declare upstream dependencies. A queued row will not spawn until all named dependencies are at `stage=done`.

Declare in the plan file header (alongside `*Branch:*` and `*Title:*`):

```markdown
*Prerequisites:* `autonomous/auth-refactor`, `autonomous/theme-context`
```

Or pass at queue time:

```bash
pipeline queue-plan <project> <plan-file> --depends auth-refactor,theme-context
```

Update an existing row's dependencies: `pipeline stage-set <project-root> <feature> <stage> --depends dep1,dep2`

Clear dependencies: `--depends ""`

**Circular dependencies** (A depends on B, B depends on A) deadlock both rows indefinitely. Resolve by clearing `depends_on` manually.

**Soft vs strict (one declaration, per-token behavior).** A `*Prerequisites:*` token is **soft** by default (holds until the prereq is `done`). Prefix with `!` for **strict** — `done` **and** its branch is an ancestor of the target. Strict maps to the single `waits_on`; **at most one `!` token per plan** (more is an error). No implicit promotion — a bare slug is soft (earlier versions auto-promoted the first slug to `waits_on`; that is removed). `queue-plan` splits the declaration into `depends_on` (soft) + `waits_on` (the one strict) under the hood; gate and storage are unchanged.

**Cross-project prerequisites.** A prerequisite token may name another registered project as `project:feature` (e.g. `example-service:PROJ-102-example-research`). The gate releases when that other-project row reaches `done`. Cross-project prerequisites are always soft — never `waits_on`; `!project:feature` and an explicit cross-project `--waits-on` are rejected (the ancestor check only works within one repo). `queue-plan` validates the named project is registered.

### Prerequisite chaining (`waits_on` + `base_branch`)

`depends_on` is a soft list gate (all prerequisites `done`). For a single strict prerequisite plus base-branch chaining, use `waits_on` / `base_branch`:

```bash
pipeline queue-plan <project> <plan-file> \
  --waits-on auth-refactor \
  --base-branch autonomous/auth-refactor
```

- `--waits-on <slug>` — the row holds until `<slug>` is `done` **and** `autonomous/<slug>` is an ancestor of this row's `target_branch`. The ancestor check is what `depends_on` lacks: a remote squash-merge can mark a row `done` before the commit is reachable from the local target, and a dependent must not start from a base that lacks the prerequisite's code. Set from a `!`-prefixed `*Prerequisites:*` token, or via this flag directly. (A bare prerequisite is soft — there is no auto-promotion.)
- `--base-branch <name>` — the feature worktree is created from `<name>` instead of `target_branch`. Point it at `autonomous/<prereq>` so the dependent's worktree contains the prerequisite's code from day one (before it merges). Opt-in only.

### Queueing a cluster

For a dependency chain of plans, queue them together and let the orchestrator chain them rather than queueing one at a time:

```bash
pipeline queue-cluster <project> <plan1.md> <plan2.md> ...
```

`queue-cluster` reads each plan's `*Prerequisites:*`, infers the dependency graph among the supplied plans, prints the execution groups (`[level-0] → [level-1] → ...`), then queues every plan with `waits_on` + `base_branch` wired for within-cluster prerequisites. Out-of-cluster prerequisites (including cross-project `project:feature` tokens) fall back to the plan's own `depends_on`. Refuses on a dependency cycle.

`queue-cluster` is a full superset of `queue-plan`: each node is queued at its own session type and models, read from the plan's annotations (`*Type:*`, `*…-Model:*`, `*Branch:*`, `*Target-Branch:*`). Because there is no per-node `--type`, **`*Type:*` is required on every clustered plan** — `queue-cluster` errors (listing the offenders) if any plan lacks it. The `/queue` skill prompts for a missing type and writes it into the plan before clustering.

---

## Troubleshooting

**`node:sqlite` errors on import:** Node.js 22+ is required (`DatabaseSync` added in 22.5.0). Run `node --version`.

**`claude --version` fails in doctor:** Ensure `claude` is on PATH or in `~/.local/bin`. Re-run `pipeline setup` to update the PATH alias.

**Orchestrator already running:** `pipeline doctor` reports state-dir writable but the orchestrator may be running. Check with the state file:

```bash
cat ~/.pipeline/orchestrator.state.json
```

**DB locked errors:** The orchestrator and CLI share WAL-mode SQLite. If you see `SQLITE_BUSY`, a previous process may have crashed mid-transaction — wait a few seconds and retry.

**Notifications not reaching downstream:** Check `<pipeline-state-dir>/notifications/` — the envelope files should be there. If they are, the publisher is doing its job; the issue is your `hooks.on_notification` hook. Run it manually against one of the envelope files to debug: `node <your-hook> <envelope.json>`. Stdout/stderr from the hook is inherited so any errors print to the orchestrator log.
