# pipeline

Multi-stage autonomous dev orchestrator for Claude Code — queue plans, watch them flow through research → dev → review → merge in a SQLite-backed queue with TUI + web dashboards.

Requires Node.js 22+ and git on PATH.

## Install

In Claude Code:

```
/plugin install andrewmaston1988-claude-plugins/pipeline
```

## Configure

```
/pipeline-setup
```

Walks through config conversationally. You'll be asked about: project to register, Slack channel (optional), model defaults, autostart, PATH alias. Each choice is explained as it's asked — defaults are sensible, you can press through if unsure.

## Try it (optional)

```
/pipeline-demo
```

Spins up a self-contained sandbox in the background — no real Claude install needed, no risk to your projects — and narrates a full lifecycle end-to-end: one main feature plus three dependents, going through queue → research → dev → review → merge, including a `[BLOCKER]` / "Fixed it!" loop and parallel dependent processing. Claude tells you why each row moves; you watch the dashboard. ~10 min, Ctrl-friendly teardown.

## Real work

- `/queue <plan-file> dev` — queue a plan
- `/pipeline` — see what's in flight
- `pipeline dashboard web` → http://localhost:8765/pipeline — watch it run
- `pipeline doctor` — confirm setup is healthy

## Backlog discovery

The pipeline scans each project's `plans/` directory and displays unqueued plan files as virtual "backlog" rows on the dashboard. No need to remember where plans live — they surface automatically. Customize the scan directory per-project with `--plans-dir`:

```
pipeline project-add my-project /path/to/project --plans-dir /custom/plans
pipeline project-update my-project --plans-dir /different/location
```

Virtual backlog rows are dim and offer queue actions. Delete only works on materialized rows (after queuing).

## Reference

See [REFERENCE.md](./REFERENCE.md) for the detailed reference — config schema, subcommand list, dashboard keybindings, notifications/forwarders, worktree paths, architecture, troubleshooting.
