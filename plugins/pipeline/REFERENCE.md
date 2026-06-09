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

- **`queued`** — row is waiting; orchestrator will spawn a session of the type named in the row.
- **`dev`** — autonomous dev session implements the plan on `autonomous/<feature>`.
- **`review`** — autonomous peer-review pass on the dev diff. Emits one of two verdicts:
  - `ready_to_ship` → advances to `test`.
  - `needs_work` → bounces back to `dev` (`review_retries += 1`). After `review_retry_budget` exhausted, parks at `manual`.
- **`test`** — autonomous test session runs the suite and sets `qa_pass`.
- **`manual`** — operator-actionable parking lot (test failure, reviewer-stuck, budget exhausted, or `[blocked: ...]`).
- **`merge`** — passed `qa_pass=true`, waiting for squash-merge via `/merge`.
- **`done`** — merged to main; row preserved for audit.

### Pipeline row columns

| Column | Description |
|--------|-------------|
| `feature` | Feature slug (primary key) |
| `stage` | Current stage: queued, dev, review, test, manual, merge, or done |
| `branch` | Git branch name (null if not yet created) |
| `qa_pass` | Test result: true, false, or null (untested) |
| `notes_extra` | Operator notes |
| `rebase_required` | Flag if branch needs rebase before merge |

**Invariant:** A row cannot reach `stage=merge` without a gate verdict — either `qa_pass=true` (test path) or `review_verdict=ready_to_ship`. The merge runner enforces this before squash-merging.

**Auto-spawn:** The orchestrator automatically spawns merge children when a pipeline row reaches `stage=merge` with no `rebase_required` flag and all dependencies satisfied. Each project is limited to one concurrent merge to avoid rebase/commit races. On successful exit (code 0), the merge script advances the row to `done`; on failure, the row remains at `merge` and an operator notification is sent.

---

## Quick start

Run the interactive setup wizard:

```bash
node plugins/pipeline/bin/pipeline.mjs setup
```

The wizard walks through 9 steps:

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
  "notifications": {
    "on_write": "/abs/path/to/forwarder.mjs"
  }
}
```

The hook is spawned once per envelope with the file path as its only argv. Stdio inherits.

### Bundled Slack forwarder

The plugin ships `scripts/forwarders/claude-slack.mjs`. The setup wizard wires it as `on_write` automatically when:

- A Slack channel is set (`notifications.governance_channel` or `notifications.pipeline_channel`)
- `claude-slack` is on PATH (installable via the `slack-bridge` plugin in this same marketplace)

Channel resolution: `pipeline_channel || governance_channel`. So pipeline events can go to a dedicated channel (e.g. `pipeline-events`) while general reports stay in your usual ops channel — keeps orchestrator pings out of curated channels.

### Bringing your own forwarder

Replace `notifications.on_write` with your own executable — anything that takes a JSON envelope path and forwards it. Read `scripts/forwarders/claude-slack.mjs` as a 50-line reference implementation. Common patterns:

- **Different notifier** (Discord, MS Teams, email, webhook): substitute the underlying API call; the envelope format stays the same.
- **Routing**: parse `envelope.priority` or `envelope.title` to choose the destination channel.
- **Filtering**: skip envelopes you don't care about (e.g. only forward `priority: "high"`).

Setup never clobbers a non-bundled `on_write` on re-run — once you point it at your own script, it stays yours.

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
| `models.doc_impact` | string | `"claude-haiku-4-5"` | Model used for doc-impact analysis during merge |
| `notifications.governance_channel` | string \| null | `null` | Slack channel name for governance reports + failure notifications (e.g. `"your-channel-name"`, without `#`); `null` disables |
| `review.skill` | string | `"/code-review"` | Slash-command invoked by review sessions |
| `review.deep_flag` | string | `""` | Extra flag appended to the review skill invocation (any string; empty disables) |

Example `~/.pipeline/config.json`:

```json
{
  "models": {
    "dev_default": "claude-haiku-4-5",
    "review_default": "claude-sonnet-4-6",
    "governor": "claude-sonnet-4-6",
    "doc_impact": "claude-haiku-4-5"
  },
  "notifications": { "governance_channel": "your-channel-name" },
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

The plugin is **notifier-agnostic**: every report and notification is written to a JSON envelope under `<pipeline-state-dir>/notifications/` (default `~/.pipeline/notifications/`). If `cfg.notifications.on_write` is set to a command, the publisher spawns it with the envelope's file path as its only argument. The hook reads the JSON, picks what it needs, and forwards to whichever sink it wants — Slack, MS Teams, Discord, Pushover, email, webhook, log shipper, anything.

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
{ "notifications": { "on_write": "/abs/path/to/forwarder.sh" } }
```

Hooks ending in `.mjs` / `.js` are auto-prefixed with `node`; everything else is exec'd directly. The hook's stdout/stderr inherit so failures are visible.

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
*Target-Branch: `main`*

## Prerequisites
- depends_on: theme-context-refactor

## Scope
- preference toggle in settings
- persist to localStorage
- fall back to prefers-color-scheme
```

| Annotation | What it does |
|------------|--------------|
| `*Branch: \`<name>\`*` | Branch the orchestrator's worktree gets. Default: `autonomous/<plan-stem>`. |
| `*Target-Branch: <name>*` | Branch the merge layer merges into. Default: `main`. |
| `## Prerequisites` with `- depends_on: <slug>` lines | Row sits at `backlog` until each named feature reaches `merge`. Multiple deps allowed. |

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
3. **Bare filename** — resolved under `<projectRoot>/plans/<file>` (the conventional location).

Whatever resolution wins, the **absolute path** is stored on the row. Every downstream consumer (session-gen, orchestrator, merge) reads it from there — no re-resolution, no convention drift.

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

The `queue-plan` command extracts and validates the merge target branch for each plan via three mechanical guards.

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

`skills/merge/runner.mjs` runs the squash-merge pipeline: rebase → verify DoD → optional doc-impact → squash merge → move plans → project commit → smoke check. Invoked by the `/merge` skill:

```bash
node plugins/pipeline/skills/merge/runner.mjs \
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
| `merge.doc_impact_enabled` | `false` | Gate step 4 (LLM-driven doc updates). Public users keep it off. |
| `plansDir` | `"plans"` | Where plan files live, relative to project root. Supports `{project}` placeholder. |

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

---

## Failure handling

| Failure | Result |
|---------|--------|
| Dev session exits non-zero | Stage stays `dev`; no test session spawned; notification sent |
| Test session exits non-zero | Partial report written; QA Pass set to `false`; notification sent |
| Orchestrator spawn fails | Stage reverted to `queued`; `[spawn-failed]` in notes; notification sent |
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

The plugin currently bundles a `governor` scheduler, a metrics CLI under `scripts/metrics/`, and the spend / baseline / anomaly / governor-spawn tables in `pipeline.db`. The governor runs scheduled background sessions that produce daily and monthly governance reports; the metrics CLI rolls up session-level analytics for those reports.

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
| `done <root> <feature>` | Mark a feature complete |
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
| `queue-plan <root> <plan-file>` | Queue a plan for orchestration |
| `queue-name-derive <brief>` | Derive a slug from a description |
| `queue-branch-extract <plan-file>` | Extract branch from plan frontmatter |

### Other

| Subcommand | Purpose |
|------------|---------|
| `notify --title <t> --message <m>` | Publish a notification envelope (forwarded if `notifications.on_write` is set) |
| `session-generate <project> <plan-file> <type>` | Generate a session file from template |
| `target-branch-get <root> <feature>` | Read the target_branch for a row |

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
    publisher.mjs           Envelope writer + on_write hook dispatcher
    merge/                  Branch merge helpers
    metrics/                Spend analytics + governance reporting (carried-along surface — see "Governor and metrics")
```

---

## Feature dependencies

Features can declare upstream dependencies. A queued row will not spawn until all named dependencies are at `stage=done`.

Declare in the plan file:

```markdown
## Prerequisites
- depends_on: auth-refactor
- depends_on: theme-context
```

Or pass at queue time:

```bash
pipeline queue-plan <project> <plan-file> --depends auth-refactor,theme-context
```

Update an existing row's dependencies: `pipeline stage-set <project-root> <feature> <stage> --depends dep1,dep2`

Clear dependencies: `--depends ""`

**Circular dependencies** (A depends on B, B depends on A) deadlock both rows indefinitely. Resolve by clearing `depends_on` manually.

---

## Troubleshooting

**`node:sqlite` errors on import:** Node.js 22+ is required (`DatabaseSync` added in 22.5.0). Run `node --version`.

**`claude --version` fails in doctor:** Ensure `claude` is on PATH or in `~/.local/bin`. Re-run `pipeline setup` to update the PATH alias.

**Orchestrator already running:** `pipeline doctor` reports state-dir writable but the orchestrator may be running. Check with the state file:

```bash
cat ~/.pipeline/orchestrator.state.json
```

**DB locked errors:** The orchestrator and CLI share WAL-mode SQLite. If you see `SQLITE_BUSY`, a previous process may have crashed mid-transaction — wait a few seconds and retry.

**Notifications not reaching downstream:** Check `<pipeline-state-dir>/notifications/` — the envelope files should be there. If they are, the publisher is doing its job; the issue is your `notifications.on_write` hook. Run it manually against one of the envelope files to debug: `<your-hook> <envelope.json>`. Stdout/stderr from the hook is inherited so any errors print to the orchestrator log.
