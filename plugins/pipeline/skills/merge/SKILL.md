---
name: merge
description: Merge one or more tested autonomous branches to main — closes plans, updates docs, squash merges, smoke checks
argument-hint: <branch> [branch ...]
---

Merge the branches in `$ARGUMENTS` to the target branch. Each branch must already
have passing test results — this command closes out completed work, it does not
run tests.

**Branches to merge:** $ARGUMENTS

`scripts/run-merge.mjs` owns the mechanics: root and branch resolution, the
target-branch lookup, the `rebase_required` and `(needs testing)` pre-checks,
model selection, and building the merge invocation. Your job is a loop — run it,
do only what its output asks, re-run.

```bash
node "$(pipeline plugin-root)/skills/merge/scripts/run-merge.mjs" --branches <b1>[,<b2>...]
```

## The loop

Each run ends one of six ways. Branch on which:

| Driver output | You do |
|---|---|
| `{"error":"missing_required_field",...}` | Ask the user for the field, re-run with the flag |
| `PAUSE: <what>` banner | The judgement it names, then re-run the printed `RE-RUN EXACTLY` command |
| Non-zero exit | Surface the message verbatim; do not retry blindly |
| `resolved:` block + `Spawn a background agent running:` | Spawn it (below) |
| `resuming at land —` + `Spawn a background agent running:` | Run the printed `--land-only` command in this session and relay its output; no subagent, no model |
| `Nothing to do — this merge is already complete.` | Report it; nothing to spawn |

The driver re-reads reality on every run, so re-running is always safe.

## Spawning

For a full merge the driver prints a fully-resolved command and the model to run
it on. A land-only resume prints no model — run that one in this session (see the
loop table above). Spawn a background agent with **exactly** the printed command —
do not reconstruct it:

```
Agent(
  description="Merge <branch(es)>",
  run_in_background=True,
  model=<the model the driver printed>,
  prompt="""
    Run this command exactly as given, from <PROJECT_DIR>:

      <the command the driver printed>

    1. Non-zero exit → report the BLOCKER lines from stderr and stop.
    2. Zero exit → report branch(es) merged, plan location(s), and the squash commit hash.
    3. For each merged branch, prune resolved bullets from the completed plan's
       `## Open Questions` — those the branch demonstrably answered. Leave genuinely
       open ones. This is judgement; read the plan, do not pattern-match.
    4. Clean up stale progress entries:
         pipeline progress-list-active <PROJECT>
       and for each slug containing the feature stem: `pipeline progress-delete <PROJECT> <slug>`.

    Report: PASS or FAIL, a one-line summary, and any BLOCKER messages.
  """
)
```

Then tell the user it is spawned and on which model. **On notification:** relay the
agent's summary verbatim.

## What needs your judgement

**Untested items.** The driver pauses when a plan carries `(needs testing)` and
lists them. Put it to the user — skip and force through, or stop? Only they can
answer. `--skip-testing` rewrites those markers to `(skipped)` and logs a WARNING,
so the override stays visible; never pass it without being told to.

**Resolved Open Questions** (in the spawn prompt, step 3). Judge whether the branch
actually answered a question, not whether it touched nearby code.

**Squash-merged history.** `step0aRebase` runs `git rebase <target>` on each branch
and fails when earlier commits were already squash-merged: the squash carries a
combined patch-id that does not match the individual commits, so the replay
conflicts against content that is already present. Git cannot infer the fork-point,
so this one is yours:

First find the worktree holding the branch. `git update-ref` succeeds on a ref
checked out in a linked worktree and leaves that worktree's index holding the old
tree, so its next `git status` reports the delta as staged:

```bash
git worktree list --porcelain | awk '/^worktree /{p=$2} /^branch refs\/heads\/<branch>$/{print p}'
```

If that prints a path, rebase in it — the branch stays checked out and the index
stays consistent:

```bash
git -C <that-worktree> rebase --onto <target_branch> <fork-point>   # fork-point = last commit predating the upstream squash
```

Only when no worktree holds the branch, replay it detached and move the ref
yourself:

```bash
wt="$(mktemp -d)/wt"
git worktree add --detach "$wt" <branch>
git -C "$wt" rebase --onto <target_branch> <fork-point>
git update-ref "refs/heads/<branch>" "$(git -C "$wt" rev-parse HEAD)"
git worktree remove --force "$wt"
```

Neither path touches the shared checkout — a `git checkout <branch>` there is what
wiped live sessions' work on 2026-11-19.
Then re-run the driver's printed command with `--no-rebase` appended, which skips
`step0aRebase` and goes straight to the 3-way squash merge. Operator-only — the
default path must keep rebasing for every branch that has not hit this exact
failure.

## Rationalisations — all rejected

| Excuse | Reality |
|---|---|
| "I remember the flags — I'll just call `merge.mjs` directly." | The driver resolves the target branch, the plans dir, and the model from live state. A remembered invocation is a guess, and it skips both pre-checks. |
| "I'll reconstruct the command, it's obvious." | It is printed. Copying it is free; retyping it is how a wrong `--plans-dir` reaches a real merge. |
| "The tree is dirty but the merge is simple — Haiku is fine." | The model is computed from three signals, not chosen. Overriding it discards the reason it was raised. |
| "`rebase_required=1` is stale, I'll merge anyway." | It means a dev session aborted its rebase. Rebase manually, then clear it explicitly with `pipeline rebase-required-set`. |
| "I'll add `--skip-testing` to get past the pause." | That flag is the user's answer, not yours. It ships untested work and says so in the log. |
