---
name: queue
description: Use when the user wants to queue a plan file for the pipeline orchestrator to pick up. Triggers — "/queue …", "queue this plan", "queue X as dev/research/test/review". SKIP for — questions about pipeline status (use /pipeline), generic chat about plans, or queueing without a plan file path.
argument-hint: <plan-file-path> [dev|research|test|review]
---

Queue a plan file so the orchestrator spawns an autonomous session for it.

**Arguments:** `$ARGUMENTS`

The first word is the plan file path (absolute, or relative to the registered project root). The optional second word is the session type — `dev` (default), `research`, `test`, or `review`.

## Step 1 — Resolve the project

```bash
git rev-parse --show-toplevel
```

Use the resulting path's last segment as the **project name**. Verify it's a registered project:

```bash
pipeline project-list --format json
```

If the current directory's project isn't registered, tell the user and exit:
> "This directory isn't a registered pipeline project. Run `pipeline project-add <name> <path>` first."

## Step 2 — Parse the arguments

- First word → `PLAN_FILE` (add `.md` if missing). If relative, resolve against the project root.
- Second word (optional) → `STYPE`, one of `dev` / `research` / `test` / `review`. Default `dev`.

If the plan file doesn't exist, tell the user the resolved path and stop.

## Step 3 — Queue it

```bash
pipeline queue-plan <project> <PLAN_FILE> --type <STYPE>
```

Report the resulting row to the user and tell them to watch progress with:

> `pipeline dashboard tui`
> or open `pipeline dashboard web` → http://127.0.0.1:8765/pipeline

If the orchestrator isn't running, surface a hint:

> The orchestrator is not running. Start it with the `o` key in the TUI's agents panel, or run `node scripts/orchestrator/index.mjs` from the plugin dir.
