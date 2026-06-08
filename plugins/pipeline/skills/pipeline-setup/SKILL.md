---
name: pipeline-setup
description: Use when a user wants to set up (or re-configure) the pipeline plugin and you can walk them through it conversationally — bypasses the TTY-only wizard. Triggers — "/pipeline-setup", "set up the pipeline plugin", "configure pipeline for me", "I just installed pipeline, what now". SKIP for — debugging a broken setup (use /pipeline + doctor), or when a TTY is available and the user prefers driving the wizard themselves.
argument-hint: (no arguments)
---

Walk the user through pipeline setup conversationally, **explaining each choice** as you go, then drive the non-interactive wizard with the answers. This skill exists because the wizard's `readline` needs an interactive TTY (which Claude Code's `!` bash session doesn't have) — but a Claude conversation has all the input it needs, plus the room to explain what each option actually changes.

**Tone**: warm, peer-level. Each question gets a one-sentence "what this does" + a one-sentence "default behaviour" + a one-sentence "implication if you change it". The user shouldn't have to read source to know what they're agreeing to.

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
  [--slack <channel>]
  [--models r=...,d=...,q=...,rvw=...]
  [--review-skill <name>]
  [--review-deep-flag <flag>]
  [--no-autostart]
  [--no-path-alias]
  [--continue-on-failed-prechecks]
```

Wait for confirmation before running. The setup writes to `~/.pipeline/config.json` and your shell profile — the user must see what's about to happen.

## Step 3 — Run it

```bash
node "$PIPELINE_BIN" setup --non-interactive <flags>
```

Stream the output (it walks the 9 wizard steps). It should end with:

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
