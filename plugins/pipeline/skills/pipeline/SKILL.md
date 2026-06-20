---
name: pipeline
description: Use when the user wants to inspect or manage a project's pipeline, or run plugin onboarding (setup, demo). Triggers — "show pipeline status", "what's in flight", "is anything blocked", "rows in manual", "restore pipeline row", "/pipeline-setup", "/pipeline-demo". Subcommands: `/pipeline setup`, `/pipeline demo`, `/pipeline [<project>]`. SKIP for — queueing new work (use /queue).
argument-hint: [setup | demo | <project>]
---

Show the pipeline rows for a project, or run onboarding flows. Without an argument, derives the project from the current git repo.

**Arguments:** `$ARGUMENTS`

## Step 0 — Route on first argument

Extract the first token from `$ARGUMENTS`:

```bash
FIRST_TOKEN=$(echo "$ARGUMENTS" | awk '{print $1}')
```

Route based on the first token:

- If `FIRST_TOKEN` is `setup` → read `setup.md` and follow it verbatim. Stop here.
- If `FIRST_TOKEN` is `demo` → read `demo.md` and follow it verbatim. Stop here.
- Otherwise → proceed to Step 1 (status flow).

**Reserved names:** `setup` and `demo` are reserved subcommand names. If a registered project happens to be literally named `setup` or `demo`, the subcommand wins. This is a theoretical risk — the pipeline plugin has never registered such a project.

## Step 1 — Pick the project

If `$ARGUMENTS` is empty:

```bash
git rev-parse --show-toplevel
```

Use the last path segment as the project name.

If `$ARGUMENTS` is present, use it as the project name.

## Step 2 — Verify it's registered

```bash
pipeline project-list --format json
```

If the project isn't in the list, tell the user and offer:

> Not a registered project. Register it with: `pipeline project-add <name> <abs-path>`

## Step 3 — Show the rows

```bash
pipeline rows <project> --format plain
```

Group the output by stage (merge / manual / test / dev / research / queued / backlog / done) and tell the user:

- How many rows are in each stage
- Any rows whose `notes_extra` starts with `blocked:` — surface those first
- Where to watch live: `pipeline dashboard tui` (or the web at http://127.0.0.1:8765/pipeline)

## Step 4 — Tell them what to do next

- If the orchestrator is off and there are queued rows: suggest starting it (`o` in the TUI agents panel, then Enter).
- If everything is `done`: suggest `/queue <plan-file>` to add new work.
- If something is `manual` due to an expired/dead session (`[dev-no-handoff]`, `[review-stuck-no-report]`): restore with `stage=dev` (or `stage=review` as appropriate). The orchestrator uses the stage directly to spawn the session, so no `notes_extra` manipulation is needed. Restore with `pipeline stage-set <project> <feature> dev`.
- If something is `manual` and `blocked:`: surface the block reason and ask whether they want to clear it (`pipeline stage-set <project> <feature> backlog` typically).

For the full CLI surface (all subcommands, flags, orchestrator management): read `../../REFERENCE.md` (relative to this skill's base directory).
