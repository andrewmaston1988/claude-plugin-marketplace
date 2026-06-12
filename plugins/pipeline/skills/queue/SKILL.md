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

## Step 3 — Secure a PR title

When this work merges, the PR title comes from — first hit wins:

1. `--title "<text>"` flag on the queue command.
2. The plan's `*Title:* <text>*` annotation under the H1.
3. The feature slug (the plan filename).

The slug fallback is the trap: a plan named `PROJ-104.md` with no title lands a PR titled **`PROJ-104`** — unhelpful in Bitbucket/GitHub. So a title is worth securing at queue time, and you don't need to edit the plan to do it.

- **If the operator's request already gave a title**, use it directly via `--title` — don't prompt.
- **If the plan has a `*Title:*` annotation**, that's enough — proceed.
- **Otherwise, recommend one:** read the plan's first H1 heading (`# …`) and ask:

  > No PR title set for `<slug>`.
  > Use the plan heading as the PR title?
  >
  >   "<H1 heading>"
  >
  > [Y]es / [e]dit / [s]kip (use slug `<slug>`)

  On **Yes**/**edit**, pass the chosen text via `--title` (shell-quote it). On **skip**, queue without `--title` and the slug is used.

## Step 4 — Queue it

```bash
pipeline queue-plan <project> <PLAN_FILE> --type <STYPE> [--title "<PR title>"]
```

Report the resulting row to the user and tell them to watch progress with:

> `pipeline dashboard tui`
> or open `pipeline dashboard web` → http://127.0.0.1:8765/pipeline

If the orchestrator isn't running, surface a hint:

> The orchestrator is not running. Start it with the `o` key in the TUI's agents panel, or run `node scripts/orchestrator/index.mjs` from the plugin dir.

## Target branch resolution

`queue-plan` resolves the row's `target_branch` (the merge destination) via this precedence chain — first hit wins:

1. `--target-branch <name>` flag on the queue command.
2. Plan file's `*Target-Branch: <name>*` annotation immediately under the title.
3. `detectDefaultBranch(projectRoot)` — reads `git symbolic-ref refs/remotes/origin/HEAD`, then `git config init.defaultBranch`.
4. `DEFAULT_TARGET_BRANCH_FALLBACK` (`"main"`) when both git lookups fail.

Existing rows: once a row has `target_branch` stored, the column wins; the chain only runs at queue time. A row queued before the chain landed keeps whatever it had — set `--target-branch` explicitly to override.

If `--target-branch` carries a prefix not in `cfg.recognised_branch_types` (default `["autonomous", "interactive"]`), `queue-plan` emits a one-line warning but proceeds. Unusual destinations are allowed; the warning is so an operator can confirm intent.

## Prerequisite chaining (`--waits-on` / `--base-branch`)

A plan can declare it depends on another with a `*Prerequisites:*` annotation (e.g. `*Prerequisites:* \`autonomous/foo-bar\``). When you queue such a plan:

- `queue-plan` auto-sets `waits_on` from the first `*Prerequisites:*` slug. The orchestrator holds the row until that prerequisite is **`done` AND its branch is an ancestor of the target** (the ancestor check catches the case where a remote squash-merge marked the prereq `done` before the commit actually landed).
- **When the plan has a `*Prerequisites:*` annotation, ask the operator:** *"This plan depends on `<slug>` — branch its worktree off `autonomous/<slug>` so it sees that code before the prereq merges? [Y/n]"*. On yes, add `--base-branch autonomous/<slug>`. On no, the dependent branches off the target as usual and only sees the prereq's code once it merges.

Flags (both optional; `--waits-on` overrides the auto-derived value):

```bash
pipeline queue-plan <project> <PLAN_FILE> --type <STYPE> \
  --waits-on <prereq-feature-slug> \
  --base-branch autonomous/<prereq-feature-slug>
```

## Queueing a whole cluster at once

For a set of plans with a dependency chain (e.g. 7 plans where each waits on the previous), don't queue them one at a time with manual waits — queue the cluster and let the orchestrator chain them:

```bash
pipeline queue-cluster <project> <plan1.md> <plan2.md> <plan3.md> ...
```

`queue-cluster` reads each plan's `*Prerequisites:*`, infers the dependency graph **among the plans in the cluster**, prints the execution groups (`[level-0] → [level-1] → ...`), then queues every plan with `waits_on` and `base_branch` wired so within-cluster dependents branch off their prerequisite's autonomous branch. Out-of-cluster prerequisites are left to the plan's own annotation. It refuses on a dependency cycle. The operator queues once; the orchestrator fans out each level as the prior one lands on the target.
