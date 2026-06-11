---
name: pipeline-setup
description: Use when a user wants to set up (or re-configure) the pipeline plugin and you can walk them through it conversationally — bypasses the TTY-only wizard. Triggers — "/pipeline-setup", "set up the pipeline plugin", "configure pipeline for me", "I just installed pipeline, what now". SKIP for — debugging a broken setup (use /pipeline + doctor), or when a TTY is available and the user prefers driving the wizard themselves.
argument-hint: (no arguments)
---

Walk the user through pipeline setup conversationally, **explaining each choice** as you go, then drive the non-interactive wizard with the answers. This skill exists because the wizard's `readline` needs an interactive TTY (which Claude Code's `!` bash session doesn't have) — but a Claude conversation has all the input it needs, plus the room to explain what each option actually changes.

**Tone**: warm, peer-level. Each question gets a one-sentence "what this does" + a one-sentence "default behaviour" + a one-sentence "implication if you change it". The user shouldn't have to read source to know what they're agreeing to.

## How to surface each config option

This skill MUST follow the same shape for every config key it prompts the user about. Adopted from the `paths-and-config-base` plan (§F); subsequent skill edits inherit the contract.

For every key the skill surfaces:

1. **Explain** in plain English what the key controls. One sentence.
2. **Show the resolved default for this user's machine** — concrete values, not abstract templates. Run the resolver against this machine's `paths.configDir`, `projectRoot`, etc., and print the result. "Default: `~/.pipeline/notifications`" is wrong; "Default: `C:\Users\Andrew\.pipeline\notifications`" is right.
3. **Give 2–3 example values** spanning common scenarios (per-project relative path, `~/...`, absolute path, `{config_dir}`-rooted, etc.).
4. **Document consequences**: which files land where; what re-resolves on each plugin run; whether existing on-disk state has to migrate when the value changes.
5. **Accept follow-ups** ("why?", "what if I set X?") from the same understanding — don't push the user back through the prompt to ask a clarifying question.

Path-shaped values must go through `resolveTemplate(value, vars, { resolveBase, configDir })` exported from `plugins/pipeline/scripts/worktree-paths.mjs`. The placeholder vocabulary and `resolveBase` category for each key are defined in `plugins/pipeline/CLAUDE.md` "Path resolution"; do not invent ad-hoc resolution rules.

The two environment-check values this skill always surfaces:

- **pipeline-home** — `paths.configDir` for this platform. Mac/Windows: `~/.pipeline`. Linux: `$XDG_CONFIG_HOME/pipeline` (fallback `~/.config/pipeline`). Tell the user the resolved value and that orchestrator state, queue DB, and notification drop files land there.
- **CLAUDE_SLACK_PLUGIN** — env override for the claude-slack notifier binary. Print resolved path + source (`env` / `cache` / `path` / not found). Explain that without it (and without a channel set) all Slack alerts silently no-op.

## Step 0 — Find the binary

The plugin lives at one of these paths depending on install method:

- Marketplace install: `~/.claude/plugins/cache/<marketplace>/pipeline/<version>/bin/pipeline.mjs`
- Local checkout: `<repo>/plugins/pipeline/bin/pipeline.mjs`

Locate it with:
```bash
ls ~/.claude/plugins/cache/*/pipeline/*/bin/pipeline.mjs 2>/dev/null | head -1
```

Store the resolved absolute path as `$PIPELINE_BIN` for the rest of the skill.

## Step 1 — Ask only about the things that matter

Most users want defaults for almost everything. Ask only what's genuinely a per-user decision. **Before each question, give the user the context they need to answer it.** Use the **AskUserQuestion tool** for discrete options; ask prose for free-form values.

### Question 1 — Project to register

**What this does**: registers a git repo as a pipeline project. The orchestrator spawns sessions per registered project, and `/queue` / `/pipeline` commands default to the project derived from your current git repo.

**Default**: register the project you're currently in (`git rev-parse --show-toplevel`; basename → project name).

**If you skip**: the orchestrator has nothing to do — you can register projects later with `pipeline project-add <name> <abs-path>`. Without at least one registered project, `/queue` will refuse with "not a registered project".

Phrasing:

> "I'll register the project you're working in (`<name>` at `<abs-path>`) so `/queue` and `/pipeline` default to it. You can always add more later with `pipeline project-add`. Add this one now?"

Options:
- "Yes, register this one" *(default)*
- "Skip — I'll add projects later"
- "Different project — give me a name + path"

### Question 2 — Slack notifications

**What this does**: pipeline posts failure / park / orchestrator-error alerts to a Slack channel via [claude-slack](https://github.com/anthropics/claude-slack). Two channel slots: `pipeline` (per-row events) and `governance` (reports). Today they default to the same value if you give one.

**Default**: disabled (no channel set). All alerts stay in `~/.pipeline/notifications/` as JSON files.

**If you skip**: you'll have to watch the dashboard or notifications dir to see when work parks at `manual`. With Slack wired, you get a ping the moment a row blocks or an orchestrator poll throws.

Phrasing:

> "What Slack channel should pipeline post failure / park alerts to? Pick a channel name (with or without `#`), or `skip` to keep alerts file-only. You can always wire it up later by editing `~/.pipeline/config.json`."

If the user picks a channel: strip a leading `#`. If `claude-slack` isn't on PATH, mention they'll need it installed for the alerts to actually fire (config gets written either way).

**Slack-bridge token provenance** — if the user asks how tokens are supplied to the bridge, explain the env-var ↔ config mapping:

| Env var | Config key | Notes |
|---|---|---|
| `SLACK_BOT_TOKEN` | `tokens.bot` | Required. Bot token (`xoxb-…`). |
| `SLACK_APP_TOKEN` | `tokens.app` | Required for Socket Mode. App token (`xapp-…`). |
| `CLAUDE_CWD` | `claude.cwd` | Optional. Working dir for the `claude` subprocess. |

Env vars win over config values. For production, set secrets in env; put non-secret defaults in `config.json`. The full mapping is documented in `plugins/slack-bridge/CONFIG.md`.

### Question 3 — Model defaults

**What this does**: chooses which Claude model the orchestrator launches for each session type. The defaults are tuned for cost-vs-quality:

| Session | Default | Why |
|---|---|---|
| **queue** (`q`) | Haiku | Fast/cheap — runs frequently to scan plans + decide spawns. |
| **research** (`r`) | Sonnet | Mid-tier — reading the codebase and synthesising notes. |
| **dev** (`d`) | Sonnet | Mid-tier — code edits, test runs. Bumping to Opus is fine if you want extra rigour, but costs ~5× more. |
| **review** (`rvw`) | Opus | Top-tier — review is roughly 1:1 with dev (every dev session gets reviewed, and a BLOCKER kicks the row back for another dev→review loop). A miss here is expensive: undetected issues become re-work cycles or land bugs in main. Paying for stronger model on review usually saves more than it costs. |

**Default**: keep the defaults above.

**If you change one**: cost ↔ quality. Going smaller saves money and risks more blocker-rework loops; going bigger spends more and tightens what each session catches.

**SKIP this question** unless the user volunteers a preference or asks about cost. If they do, ask only for the session types they want to override.

### Question 3b — on_merge_ready hook

**Always ASK this question** — alongside Slack (Q2), the merge-workflow hooks are how pipeline integrates with the user's day-to-day. Most users want a real PR-based workflow rather than the default local squash-and-push to the target branch, so don't bury this as a skippable sub-question of Q3 (models).

**What this does**: runs a script/executable whenever a pipeline row reaches `stage=merge` — fires for all projects, regardless of whether `autoMerge` is enabled. The hook receives four env vars: `PIPELINE_PROJECT`, `PIPELINE_FEATURE`, `PIPELINE_BRANCH`, `PIPELINE_TARGET_BRANCH`. Common use: open a PR on GitHub/Bitbucket when a branch is ready to merge, or post a Slack ping.

**Default**: disabled (no hook set).

**If you skip**: merge-ready events are still recorded internally; you just won't get an external notification or PR opened. Add it later by setting `hooks.on_merge_ready` in `~/.pipeline/config.json`.

**Before asking**: check whether `~/.pipeline/hooks/on-merge-ready.mjs` already exists. If it does and `hooks.on_merge_ready` is not already set in config, say: "Found existing hook at `~/.pipeline/hooks/on-merge-ready.mjs` — wire this into config? [Y/n]". On yes, use that path directly and skip the question below. On no, proceed with the normal question.

**Ask the user what they want to happen** when a row is merge-ready. Don't lead with Slack — ask first, then figure out how to wire it. Common answers and how to handle each:

- **"Post to Slack"** — check `~/.pipeline/config.json` for `hooks.on_notification` (or legacy `notifications.on_write`). If it points to a `claude-slack.mjs` file, you already have the forwarder path. Write `~/.pipeline/hooks/on-merge-ready.mjs` that reads the env vars, builds a JSON envelope, and calls that forwarder via `spawnSync("node", [claudeSlackPath, tmpEnvelopeFile])`. Example envelope: `{ title: "Merge ready: <feature>", message: "\`<branch>\` → \`<target>\` in *<project>* is ready to merge.", priority: "normal" }`. Write the tmp file to `os.tmpdir()`.
- **"Run a webhook / curl"** — write a wrapper `.mjs` that reads the env vars and runs the appropriate command.
- **"Log to a file"** — write a wrapper `.mjs` that appends a line to `~/.pipeline/logs/merge-ready.log`.
- **"I have a script already"** — ask for the absolute path; use it directly.
- **"Skip"** — omit `--merge-hook`.

For any case where you write a new script: write it to `~/.pipeline/hooks/on-merge-ready.mjs` (create the dir if needed), make it self-contained, and show the user the file content before writing.

**If the hook creates a GitHub PR**, use `pipeline row-get <project> <feature> --format json` to read the full pipeline row (PR title, dev model, target branch) in one call. `PLUGIN_DIR` is set in the hook's spawn env by the orchestrator — use it to locate the binary:

```js
// PLUGIN_DIR is set in the hook's spawn env by the pipeline orchestrator.
const pipelineBin = `${process.env.PLUGIN_DIR}/bin/pipeline.mjs`;
const rowResult = spawnSync(process.execPath, [pipelineBin, "row-get", project, feature, "--format", "json"], { encoding: "utf8", env: process.env });
let row = {};
try { row = JSON.parse(rowResult.stdout?.trim() || "{}"); } catch {}
const title = row.pr_title || feature;
// then: spawnSync(ghBin, ["pr", "create", "--title", title, ...])
```

Pass the hook path as `--merge-hook <abs-path>` (or omit to leave unset).

### Question 3c — on_merge hook

**Always ASK this question** — pairs with Q3b. If the user wired up `on_merge_ready` to open a PR, they almost certainly want `on_merge` to merge that PR via the platform's API rather than fall back to a local squash. Asking the two as a related cluster keeps the merge workflow coherent.

**What this does**: replaces the pipeline's local squash merge with a custom script. The hook receives the same four env vars as `on_merge_ready` (`PIPELINE_PROJECT`, `PIPELINE_FEATURE`, `PIPELINE_BRANCH`, `PIPELINE_TARGET_BRANCH`) and is responsible for performing the actual merge. When unset, the pipeline squash-merges locally as usual.

**Default**: disabled (local squash merge used).

**If you skip**: the pipeline squash-merges the branch to the target branch locally and pushes. GitHub/Bitbucket won't show the PR as "merged" — the PR will close when the branch is deleted.

**If you set it**: the hook fully owns the merge step. A common hook for GitHub repos:

```js
// ~/.pipeline/hooks/on-merge.mjs
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
const gh = join(homedir(), ".local", "bin", process.platform === "win32" ? "gh.exe" : "gh");
const branch = process.env.PIPELINE_BRANCH;
const result = spawnSync(gh, ["pr", "merge", branch, "--squash", "--delete-branch", "--auto"], {
  stdio: "inherit",
  env: { ...process.env, PATH: `${join(homedir(), ".local", "bin")};${process.env.PATH}` },
});
process.exit(result.status ?? 1);
```

**Before asking**: check whether `~/.pipeline/hooks/on-merge.mjs` already exists. If it does and `hooks.on_merge` is not already set in config, say: "Found existing hook at `~/.pipeline/hooks/on-merge.mjs` — wire this into config? [Y/n]". On yes, use that path directly and skip the question below. On no, proceed with the normal question.

**Ask the user** whether they want to use a GitHub PR merge or keep the local squash. Common answers:
- **"GitHub PR merge"** — write the above hook to `~/.pipeline/hooks/on-merge.mjs` and pass `--on-merge <path>`.
- **"Keep local squash"** — omit `--on-merge`.
- **"I have a script already"** — ask for the path and use it directly.

Pass the hook path as `--on-merge <abs-path>` (or omit to keep local squash).

### Question 3d — Plans directory (`plansDir`)

**What this does**: tells every consumer (CLI `backlog-scan`, dashboard backlog, session-gen, demo) where each project's plan files live. The value is a template — placeholders are resolved per-project against that project's root.

**Resolved default for this machine**: `<project-root>/plans/` — i.e. for project `myapp` at `C:\code\myapp` the resolver returns `C:\code\myapp\plans`. Use `pipeline doctor` after setup to see the materialised path.

**Placeholder vocabulary**:

| Placeholder | Source |
|---|---|
| `{root}` | the project root path |
| `{root_parent}` | `dirname(root)` |
| `{root_grandparent}` | `dirname(dirname(root))` |
| `{project}` | the project name |

Leading `~/` expands to the home directory; absolute paths pass through unchanged. Unknown placeholders are left literal so a typo (`{projetc}/plans`) produces a directory whose name visibly contains the broken token.

**Examples**:

- `plans` *(default)* → `<project-root>/plans/`
- `../CLAUDE/repos/{project}/plans` → sibling knowledge-base repo, one plans dir per project
- `{root_parent}/shared-plans` → a single shared plans directory at the project root's parent
- `~/work/plans/{project}` → absolute path under the home directory

**Consequences**: every read of the plans directory (dashboard backlog, `pipeline backlog-scan`, session-gen reading plan content) routes through `resolvePlansDir` and sees the same answer. If a project row's `plans_dir` column is set (via `pipeline project-add --plans-dir <abs>` / `pipeline project-update --plans-dir <abs>`), the per-project value wins over `cfg.plansDir` for that one project. No on-disk migration is performed when the value changes — point the value at where the plans already are.

**Default**: keep `plans` unless the user's plans live elsewhere (e.g. a separate knowledge-base repo).

**SKIP this question** unless the user volunteers that their plans are not under each project's root.

### Question 3d-web — Web dashboard port and host (`web.port`, `web.host`)

**What this does**: `web.port` sets the TCP port the web dashboard listens on. `web.host` controls which network interfaces it binds to — loopback-only (`127.0.0.1`, default) or all interfaces (`0.0.0.0` for LAN access).

**Resolved defaults**: port `8765` (outside Windows Hyper-V exclusion range 5000–5100); host `127.0.0.1` (loopback-only).

**Port examples**:

- `8765` *(default)*
- `9000` — if 8765 is already occupied by another service
- `3001` — common local-dev preference

**Host examples**:

- `"127.0.0.1"` *(default)* — dashboard only reachable from this machine
- `"0.0.0.0"` — bind all IPv4 interfaces; reachable from other machines on the LAN
- `"::"` — dual-stack (IPv4 + IPv6) all-interfaces

**Consequences**: changing the port invalidates existing browser bookmarks. The CLI `--port` and `--host` flags override config values for a single session (`pipeline dashboard web --host 0.0.0.0 --port 9999`). The doctor check `web-port-conflict` warns when a non-dashboard process is bound to the configured port at startup.

**SKIP this question** unless the user mentions port conflicts, LAN access needs, or a host/port preference.

If asked, set `web.port` and/or `web.host` in `~/.pipeline/config.json` and confirm with the bookmark URL: `http://localhost:<port>/pipeline`.

### Question 3e — Branch conventions

**What this does**: tells the queue lint which `<prefix>/...` patterns count as orchestration branches. `--target-branch` values whose prefix isn't on this list trigger a one-line warning (not an error) — useful when an operator passes an unfamiliar destination so they can confirm intent.

**Default**: `["autonomous", "interactive"]`. Orchestrator-spawned rows live on `autonomous/<slug>`; operator-driven multi-commit work lives on `interactive/<slug>`. The wizard also shows the **detected default branch** of the first registered project (via `git symbolic-ref refs/remotes/origin/HEAD` then `git config init.defaultBranch`, falling back to `main`). That value is what `target_branch` resolves to when neither a flag nor a `*Target-Branch:` plan annotation is set.

**If you skip**: defaults stand. The lint still warns on unrecognised prefixes; it never blocks queueing.

**Precedence chain `queue-plan` uses for the row's `target_branch`** (first hit wins):

1. `--target-branch <name>` flag.
2. Plan file's `*Target-Branch: <name>*` annotation.
3. `detectDefaultBranch(projectRoot)`.
4. `DEFAULT_TARGET_BRANCH_FALLBACK` (`"main"`).

**SKIP this question** unless the user volunteers a non-standard branch prefix (e.g. a corporate `feature/` or `release/` convention). If they do, accept a comma-separated list and pass it as `--recognised-branch-types <list>`.

### Question 3f — Worktree layout

This block covers three related config keys: `worktree_base`, `report_subpath`, and `report_publish_branch_template`. Phase 3b made one worktree per feature the default — every dev/research/review/test/merge session for a given feature operates inside the same worktree. The keys below let an operator move that worktree off the default location.

**Always ASK this question** — every other worktree-touching surface (dev sessions, review reports, test reports, merge) ends up at the resolved path. Quietly defaulting silently chooses where every feature's worktree lands on disk.

#### `worktree_base`

**What this does**: the template that produces the on-disk directory where the agent for this feature runs. Every dev, review, test, and merge session for this feature uses this same path.

**Resolved default for this machine**: `<root_parent>/.worktrees/<project>/<feature>` — e.g. for project `myapp` at `C:\code\myapp`, feature `add-login`, the resolver returns `C:\code\.worktrees\myapp\add-login`. Run `pipeline doctor` after setup to see the materialised path.

**Placeholder vocabulary**:

| Placeholder | Source |
|---|---|
| `{root}` | the project root path |
| `{root_parent}` | `dirname(root)` |
| `{root_grandparent}` | `dirname(dirname(root))` |
| `{project}` | the project name |
| `{feature}` | the row's feature slug |
| `{kind}` | session kind (`dev`, `review`, `qa-test`, etc) |

Leading `~/` expands to the home directory; absolute paths pass through unchanged. Unknown placeholders are left literal so a typo (`{projetc}/...`) produces a directory whose name visibly contains the broken token.

**Examples**:

- `{root_parent}/.worktrees/{project}/{feature}` *(default)* → per-project worktree dir at root's parent
- `{root_grandparent}/worktrees/{project}/{feature}` → shared worktrees parent two levels above
- `~/wt/{project}/{feature}` → absolute path under the home directory

**Consequences**: every session resolves through `orchestratorWorktreePath` and sees the same answer. Existing on-disk worktrees from a previous layout aren't migrated — `pipeline doctor`'s `worktree-layout-stale` check prints a `git worktree remove <path>` command per stale entry so the operator can clean them up by paste.

#### `report_subpath`

**What this does**: the per-kind subdirectory (under the feature worktree) into which the session writes its report. Object keyed by kind.

**Resolved default for this machine**:

```json
{ "code-review": "reports", "qa-test": "test-reports" }
```

So a review report for feature `add-login` at the default `worktree_base` lands at `C:\code\.worktrees\myapp\add-login\reports\<file>.md`.

**Examples**:

- `{ "code-review": "reports", "qa-test": "test-reports" }` *(default)*
- `{ "code-review": "review", "qa-test": "test" }` → shorter dir names

**Consequences**: changing this for an established project means the merge skill's prior-verdict discovery (which reads from the publish branch via `git ls-tree`/`git show`) won't find old reports under the old path. New reports land at the new path on the next session.

#### `report_publish_branch_template`

**What this does**: the side-branch name the stash-switchback dance publishes each report to. Placeholders: `{kind}`, `{feature}`.

**Resolved default for this machine**: `{kind}/{feature}` — review reports go to `code-review/<feature>`, test reports go to `qa-test/<feature>`.

**Examples**:

- `{kind}/{feature}` *(default)*
- `reports/{kind}/{feature}` → namespace report branches under a `reports/` prefix

**Consequences**: each retry's `git checkout -B {kind}/{feature}` force-resets the publish branch to the current dev HEAD plus the new report. Prior-retry commits become unreachable from the branch tip — the merge skill only consumes the latest verdict, so functionally fine, but the per-retry audit trail isn't preserved on the side-branch.

#### Wiring + how to ask

In the conversational walkthrough, present the two options the wizard shows:

1. **Recommended** (one worktree per feature, project-namespaced) — print the resolved default for the user's first-registered project.
2. **Custom** — accept a template string; surface unknown placeholders as a warning (they render literally, which is loud).

Pass the answer as `--worktree-layout 1` (default) or `--worktree-layout 2 --worktree-base "<template>"`. The recommended choice writes the phase 3b defaults to all three keys.

**Upgrade nudge for existing installs**: mention that `pipeline doctor`'s `worktree-layout-stale` check warns when on-disk worktrees diverge from the resolved template and prints copy-pasteable `git worktree remove` lines for cleanup. No automatic migration runs.

### Question 3g — Governor (optional)

The governor is an optional background agent that generates daily/status/monthly spend reports and posts them to the `governance` Slack channel. It is opt-in: set `cfg.governor.enabled = true` to activate it.

**What it does**: the orchestrator spawns a read-only Claude session on a cron-like schedule (00:01, 06:01, 12:01, 18:01 UTC daily; 00:01 on the first of each month). The session reads `pipeline.db` and writes a markdown report to `cfg.governor.reports_dir`.

**Governor env-var contract** — when the orchestrator spawns the governor session, it sets these env vars in the child process:

| Variable | Value | Notes |
|---|---|---|
| `CORRELATION_ID` | unique run id | Keyed off the spawn timestamp. |
| `REPORT_TYPE` | `full` / `status` / `monthly` | Determines which report file is written. |
| `REPORT_DATE` | `YYYYMMDD` or `YYYYMM` | Date key for full/status; month identifier for monthly. |
| `REPORT_MONTH` | `YYYYMM` | Always the month identifier, regardless of report type. |
| `PIPELINE_DB` | absolute path | Path to `pipeline.db`; use in shell commands as `$PIPELINE_DB`. |
| `PLUGIN_DIR` | absolute path | Plugin root dir; use as `node $PLUGIN_DIR/scripts/…`. |

These mirror the `{{…}}` template placeholders expanded at render time. Custom governor templates can reference both forms.

**Config keys** (`cfg.governor.*`):

| Key | Default | Notes |
|---|---|---|
| `enabled` | `false` | Must be `true` to activate governor spawning. |
| `project` | `null` | Name of the registered project whose `root_path` is used as fallback dirs. |
| `template_path` | _(bundled)_ | Path to a custom governor session template. |
| `reports_dir` | `<project-root>/reports` | Where governance markdown reports land. |
| `session_dir` | `<project-root>/sessions` | Where governor session files are written. |
| `log_dir` | `<project-root>/logs` | Where governor stdout/stderr logs go. |

**SKIP this question** unless the user asks about automated spend tracking or daily governance reports. If they want it, confirm `cfg.governor.enabled = true` and `cfg.governor.project = "<name>"` in `~/.pipeline/config.json`.

### Question 4 — Autostart

**What this does**: installs the orchestrator as an OS-level scheduled task so it starts at login and survives reboots — Task Scheduler on Windows, launchd plist on macOS, systemd user unit on Linux.

**Default**: YES.

**If you skip**: you need to start the orchestrator manually each session — from the dashboard's agents panel (`o` key, then Enter) or by running `node scripts/orchestrator/index.mjs` from the plugin dir. Pipeline rows still get queued just fine, they just won't be picked up until something starts the orchestrator.

### Question 5 — PATH alias

**What this does**: adds a `pipeline` alias to your interactive shell profile (PowerShell function on Windows, `alias` line in `~/.bashrc` / `~/.zshrc` on Unix) AND drops a non-interactive shim at `~/.local/bin/pipeline.cmd` + `~/.local/bin/pipeline` so the command works from any context (your terminal, CI scripts, Claude Code's Bash tool).

**Default**: YES.

**If you skip**: you'll have to type `node <abs-path>/pipeline.mjs` every time, OR manage the alias yourself. The non-interactive shim is the bit that makes `/queue`, `/pipeline`, `/pipeline-demo` in Claude Code work without a shell restart, so skipping it is rarely worth it.

**Bundle 4 + 5 in one AskUserQuestion** — both default YES, both are independently skippable:

Options:
- "Both yes (recommended)" *(default)*
- "Autostart only — I'll PATH-alias myself"
- "PATH alias only — I'll start the orchestrator myself"
- "Neither — I'll wire it all up by hand"

## Step 2 — Build the command

Assemble flags from answers. Show the user **the full command including the flags they didn't choose** so they see the defaults that are about to be applied:

```
pipeline setup --non-interactive
  [--register-project <name>:<absolute-path>]
  [--worktree-layout 1|2] [--worktree-base "<template>"]
  [--slack <channel>]
  [--models r=...,d=...,q=...,rvw=...]
  [--review-skill <name>]
  [--review-deep-flag <flag>]
  [--merge-hook <abs-path>]
  [--on-merge <abs-path>]
  [--no-autostart]
  [--no-path-alias]
  [--continue-on-failed-prechecks]
```

Wait for confirmation before running. The setup writes to `~/.pipeline/config.json` and your shell profile — the user must see what's about to happen.

## Step 3 — Run it

```bash
node "$PIPELINE_BIN" setup --non-interactive <flags>
```

Stream the output (it walks the 10 wizard steps). It should end with:

> All checks passed.
> Setup complete!

If a check fails, surface it and offer either to re-run with `--continue-on-failed-prechecks` (proceed despite warnings) or to fix the underlying issue first. The most common failures:

- **No git on PATH** — install Git.
- **Node < 22** — pipeline needs `node:sqlite` which is 22+. Upgrade or use `nvm use 22`.
- **Already-registered project's root_path is missing** — earlier demo crash leftover; `pipeline project-remove <name> --purge` clears it.

## Step 4 — Tell them what's next

After success, summarise what just changed and what they can do now:

- `~/.pipeline/config.json` written (models, Slack channels, project list)
- `~/.pipeline/pipeline.db` is the SQLite DB the orchestrator + dashboards read
- Orchestrator autostart entry installed (if they chose)
- `pipeline` PATH alias added to shell profile (if they chose) — **restart their shell** for the interactive alias to take effect; the `~/.local/bin` shim works immediately
- At least one project registered (if they chose)

Suggested next moves:

- `pipeline doctor` to confirm everything's wired (works without shell restart via the shim)
- `/pipeline-demo` to see the full lifecycle end-to-end with narration
- `/queue <plan-file> dev` to queue real work in a registered project

## Anti-patterns

- **Don't run the wizard directly.** It hangs without a TTY. Always pass `--non-interactive`.
- **Don't ask every question with no context.** Every question gets the what/default/implication trio so the user knows what they're agreeing to.
- **Don't ask about every single model.** Defaults are good; only ask when the user has a reason.
- **Don't proceed without showing the assembled command.** Setup writes to `~/.pipeline/config.json` and shell profile — the user must see what's about to happen.
