---
name: pipeline
description: Use when the user wants to inspect or manage a project's pipeline — rows in flight, queued, blocked, recently done, or needing manual recovery. Triggers — "show pipeline status", "what's in flight", "is anything blocked", "rows in manual", "restore pipeline row", "pipeline rows", any question about pipeline queue state. SKIP for — queueing new work (use /queue), deep cross-project triage (use /pipeline-review), or starting a demo (use /pipeline-demo).
argument-hint: [<project>]
---

Show the pipeline rows for a project. Without an argument, derives the project from the current git repo.

**Arguments:** `$ARGUMENTS`

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
- If something is `manual` due to an expired/dead session (`[dev-no-handoff]`, `[review-stuck-no-report]`): restore with `stage=queued` + `notes_extra=type=dev` (or `type=review` as appropriate). The orchestrator reads the `type=` prefix from `notes_extra` to pick the session template — without it the row sits queued but won't dispatch. `pipeline stage-set` doesn't set `notes_extra`; update the DB directly if needed.
- If something is `manual` and `blocked:`: surface the block reason and ask whether they want to clear it (`pipeline stage-set <project> <feature> backlog` typically).

For the full CLI surface (all subcommands, flags, orchestrator management): read `../../REFERENCE.md` (relative to this skill's base directory).
