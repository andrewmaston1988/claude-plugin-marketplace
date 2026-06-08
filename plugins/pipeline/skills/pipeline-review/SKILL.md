---
name: pipeline-review
description: Use when the user wants cross-project triage of every pipeline — surfaces blocked rows, stuck stages, QA-failed rows, and rows needing human attention. Triggers — "/pipeline-review", "what needs attention across pipelines", "anything stuck", "morning triage". SKIP for — single-project status (use /pipeline) or queueing new work (use /queue).
argument-hint: [<project>] [<feature>]
---

Walk every (or one) registered project's pipeline and surface what needs human attention.

**Arguments:** `$ARGUMENTS` — optional project filter, then optional feature filter.

## Step 1 — Get the project list

```bash
pipeline project-list --format json
```

If a `<project>` arg was given, narrow to that one project.

## Step 2 — For each project, fetch rows

```bash
pipeline rows <project> --format plain
```

Bucket the rows into:

- **Blocked** — `notes_extra` starts with `blocked:` (manual stage, needs operator)
- **QA failed** — `qa_pass = 0`
- **Stuck** — stage hasn't advanced (no progress steps changed) for > 30 min — surface the feature + stage + age
- **In flight** — `dev` / `research` / `test` / `review` rows actively progressing
- **Queued** — not yet picked up by the orchestrator
- **Backlog** — not yet queued
- **Done** — finished

## Step 3 — Look at active sessions for context

```bash
pipeline sessions <project>
```

For sessions in flight, fetch their progress:

```bash
pipeline progress-list-active <project>
```

So you can report `step X / Y` per active feature.

## Step 4 — Report

Print a markdown report with these sections, in order:

1. **Needs attention** — Blocked + QA failed rows with their notes
2. **Stuck** — In-flight rows older than 30 min with no progress
3. **In flight** — Active rows with current step/total
4. **Queued / backlog** — Counts and feature names
5. **Done (recent)** — Top 5 most recent done rows

End by asking the user which item they want to dig into — for blocked rows offer to clear them (`pipeline stage-set ... backlog`); for QA failed offer to re-queue.

If a `<feature>` arg was given, skip the report and go straight into focused details for that single row: row state, notes, last error, session history (via `pipeline cycle-log <project> <feature>` if available), most recent agent-log entries.
