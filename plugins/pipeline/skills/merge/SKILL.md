---
name: merge
description: Merge one or more tested autonomous branches to main — closes plans, updates docs, squash merges, smoke checks
argument-hint: <branch> [branch ...]
---

Merge the branches listed in `$ARGUMENTS` to main. Each branch must have
passing test results before this command is run — this command does not run
tests, it closes out completed work.

**Branches to merge:** $ARGUMENTS

All mechanical work (git, plan moves, pipeline updates, doc edits, commit
bodies, smoke check) is performed by `skills/merge/merge.mjs`. This page
is a thin wrapper: locate `PLUGIN_ROOT`, parse `$ARGUMENTS` into a branch
list, invoke the script, surface stderr to the user.

## Step 1 — Locate `PLUGIN_ROOT` and derive `PROJECT_DIR`

```bash
PLUGIN_ROOT=$(pipeline plugin-root)
PROJECT_DIR=$(git rev-parse --show-toplevel)
PROJECT=$(basename "$PROJECT_DIR")
```

## Step 1.5 — Resolve target branch

Detect the repo's default branch, then check the pipeline DB for a plan-level override:

```bash
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|.*/||')
[ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH=$(git config init.defaultBranch 2>/dev/null || echo "main")

FEATURE="${branch#autonomous/}"
TARGET_BRANCH=$(pipeline rows "$PROJECT" --feature "$FEATURE" --format json \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const r=JSON.parse(d);process.stdout.write(r[0]?.target_branch||'');}catch{}})" 2>/dev/null)
[ -z "$TARGET_BRANCH" ] && TARGET_BRANCH="$DEFAULT_BRANCH"
```

Capture as `$target_branch`. If the DB lookup fails or returns blank, fall back to `$DEFAULT_BRANCH`.

## Step 2 — Parse `$ARGUMENTS` into a branch list

Split `$ARGUMENTS` on whitespace or commas. Each entry should already be in
`autonomous/<slug>` form (or `<slug>` — the runner normalises). Join into a
single comma-separated list for the `--branches` flag.

## Step 2.4 — Pre-check: refuse if any branch has `rebase_required=1`

For each branch, look up its row in the project's pipeline DB and read the `rebase_required` column. If any row has `rebase_required=1`, the dev session aborted its rebase — refuse outright; do not spawn the merge agent.

```bash
for branch in <b1> <b2> ...; do
  FEATURE="${branch#autonomous/}"
  FLAG=$(pipeline rows "$PROJECT" --feature "$FEATURE" --format json \
    | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const r=JSON.parse(d);process.stdout.write(r[0]?.rebase_required?'1':'0');}catch{process.stdout.write('0');}})")
  if [ "$FLAG" = "1" ]; then
    echo "REFUSED: $branch has rebase_required=1 — rebase manually, then clear with: pipeline rebase-required-set $PROJECT $FEATURE 0"
    exit 1
  fi
done
```

If any branch fails the check: tell the user verbatim which branch is flagged and stop. Do not proceed to Step 2.5.

## Step 2.5 — Pre-check: Model selection (inline, fast)

Run two checks before spawning:

```bash
# Check 1: is any branch diverged from the target branch (rebase required)?
DIVERGED=0
for branch in <b1> <b2> ...; do
  if ! git merge-base --is-ancestor "$target_branch" "$branch"; then
    DIVERGED=1
    break
  fi
done

# Check 2: does any plan have (needs testing) items?
# Resolve plan file path from the pipeline DB row.
NEEDS_TESTING=0
for branch in <b1> <b2> ...; do
  FEATURE="${branch#autonomous/}"
  PLAN_FILE=$(pipeline rows "$PROJECT" --feature "$FEATURE" --format json \
    | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const r=JSON.parse(d);process.stdout.write(r[0]?.plan_file||'');}catch{}})")
  if [ -f "$PLAN_FILE" ] && grep -q "(needs testing)" "$PLAN_FILE"; then
    NEEDS_TESTING=1
    break
  fi
done

# Check 3: is the working tree dirty?
DIRTY_STASH=0
if [ -n "$(git status --short)" ]; then
  DIRTY_STASH=1
fi
```

**Model decision (Haiku or Sonnet only — no Opus):**
- Any of: diverged branch, `(needs testing)` in plan, dirty stash → **Sonnet**
- All clean → **Haiku**

Announce: `"Spawning merge for <branch(es)> — model: <Haiku|Sonnet> (<reason>)"`

## Step 2.7 — Resolve `--plans-dir` from config

Read `plansDir` from the pipeline config via the CLI (platform-safe, uses the same path resolution as `loadPipelineConfig()`). If set, resolve the `{project}` placeholder and compute an absolute path. If relative, resolve relative to `PROJECT_DIR`.

```bash
PLANS_DIR_FLAG=""
RAW_PLANS_DIR=$(pipeline config-get plansDir 2>/dev/null)

if [ -n "$RAW_PLANS_DIR" ]; then
  # Replace {project} placeholder with the project name
  RESOLVED_PLANS_DIR="${RAW_PLANS_DIR/\{project\}/$PROJECT}"
  # If relative, make it absolute relative to PROJECT_DIR
  case "$RESOLVED_PLANS_DIR" in
    /*) ;;  # already absolute
    *)  RESOLVED_PLANS_DIR="$PROJECT_DIR/$RESOLVED_PLANS_DIR" ;;
  esac
  PLANS_DIR_FLAG="--plans-dir $RESOLVED_PLANS_DIR"
fi
```

## Step 3 — Spawn background agent

```
Agent(
  description="Merge <branch(es)> to main",
  run_in_background=True,
  model="haiku" | "sonnet",   ← from Step 2.5 pre-check
  prompt="""
    Run the merge for <branch(es)>.
    plugin-root: <PLUGIN_ROOT>. project-dir: <PROJECT_DIR>.
    branches: <b1,b2,...>

    Steps:
    1. If working tree is dirty, stash changes first (git stash --include-untracked); remember to pop stash after merge completes.
    2. Ensure you are on the target branch (git checkout "$target_branch").
    3. Run: node <PLUGIN_ROOT>/skills/merge/scripts/merge.mjs \
         --branches <b1,b2,...> \
         --project-dir <PROJECT_DIR> \
         --session-slug merge_<session-id> \
         <PLANS_DIR_FLAG>
    4. If exit code is non-zero, report the BLOCKER lines from stderr.
    5. If exit code is zero, report: branch(es) merged, plan location(s), squash commit hash.
    5.5. For each merged branch: read the completed plan file from <PROJECT_DIR>/plans/complete/<slug>.md (or the plansDir equivalent). In the ## Open Questions section, remove any bullets that were clearly resolved by the branch work — i.e., questions about implementation approach, design decisions, or unknowns the branch demonstrably answered. Leave questions that remain genuinely open. Use Edit to apply removals.
    5.6. For each merged branch: clean up any lingering session progress entries whose slug contains the branch stem. Run:
         pipeline progress-list-active $PROJECT
         Parse the JSON output and collect slugs that contain the feature stem (the part after "autonomous/" in the branch name). For each matching slug, run: pipeline progress-delete $PROJECT <slug>
         This removes orphaned dev/review/test progress dashboards for the feature.
    6. If stash was created in step 1, pop it now (git stash pop).

    Report back with: PASS or FAIL, one-line summary, any BLOCKER messages.
  """
)
```

## Step 4 — Return immediately

Tell the user: `"Merge spawned for <branch(es)> — will report back when done. (model: <Haiku|Sonnet>)"`

**On notification:** relay the agent's summary to the user verbatim.

If the BLOCKER is `plan has (needs testing) items`, do not re-run silently. Surface the untested items to the user and ask:

> "These items are untested — skip and mark as `(skipped)` to force through? (yes/no)"

On `yes`: add `--skip-testing` to the runner command and re-spawn. The flag rewrites `(needs testing)` → `(skipped)` in the plan with a WARNING in the merge log so the override is visible.

On `no` (or any other response): stop and tell the user to complete testing first.

## Recovery — squash-merged-history branches (`--no-rebase`)

`step0aRebase` runs `git rebase <target_branch>` on each feature branch. This fails when the branch's earlier commits were already squash-merged into the target: the squash carries a combined patch-id that doesn't match the individual commits, so `git rebase` replays them, conflicts against their already-present content, and aborts the whole merge. This is a git limitation — the script cannot infer the fork-point automatically.

The operator-driven recipe:

1. **Linearise the branch manually** using `--onto` to skip past the already-squashed commits. `<fork-point>` is the sha of the last commit on the branch that pre-dates the upstream squash (typically the commit where the branch diverged from the pre-squash state):

   ```bash
   git checkout <branch>
   git rebase --onto <target_branch> <fork-point> <branch>
   # Resolve any conflicts on the genuinely new commits, then continue.
   ```

2. **Invoke the merge with `--no-rebase`** so `step0aRebase` is skipped and the runner goes straight to the 3-way squash merge against the linearised branch:

   ```bash
   node <PLUGIN_ROOT>/skills/merge/scripts/merge.mjs \
     --branches <branch> \
     --project-dir <PROJECT_DIR> \
     --no-rebase \
     <PLANS_DIR_FLAG>
   ```

All other behaviour (DoD checks, squash, plan move to `complete/`, project commit, smoke check) is preserved. `--no-rebase` is operator-only: the default merge path still runs `step0aRebase` and should not be changed for branches that haven't hit this exact failure mode.
