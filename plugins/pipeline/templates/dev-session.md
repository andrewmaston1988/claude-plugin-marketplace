# Dev Session — {{FEATURE}}

{{PROGRESS_TRACKING}}

## Context

- Project: `{{PROJECT}}`
- Project root: `{{PROJECT_ROOT}}`
- Working directory: `{{CWD}}`
- Plan file: `{{PLAN_PATH}}`
- Branch: `{{BRANCH}}` (target: `{{TARGET_BRANCH}}`)
- Correlation ID: `$CORRELATION_ID`

## Plan

{{PLAN_CONTENT}}

---

## Mission

Implement the plan above. One session covers exactly one plan file — no exceptions. Work through items in the order listed in the plan's Current Status table; state any skips and why. The branch name is derived from the plan file name — do not invent a different name.

---

## Token Governance — Self-Policing

You are running on a metered context window and a metered budget. The Governor reviews
spend after the fact; you police it in the moment. Both layers are required.

### Context hygiene — non-negotiable

- The context window is finite and expensive. Every read is a debit.
- Before any file read, decide the slice: `head -N`, `tail -N`, `Read offset+limit`, or `grep -A N "pattern"`. Reading whole files when a section will do is a defect.
- Never re-read a file you have already parsed this session. If you need to re-check, use `grep` against the path, not a full Read.
- Pipe any potentially large command output through `| head -100`. Raw `pytest -v`, `npm install`, `git log`, build output flooding context is a defect.
- Never widen Glob/Grep scope beyond what the current step needs. `**/*` searches across the whole repo are a last resort, not a first one.

### Mandatory pruning — every 5 turns

At turn 5, and every 5 turns thereafter, write four lines via `{{PIPELINE_BIN}} progress-note {{PROJECT}} $CORRELATION_ID "..."`:
1. **Done:** what has been accomplished.
2. **Open:** what remains and what is blocking it.
3. **Loop check:** are you repeating an investigation or test? If yes, pivot or halt.
4. **Token check:** are you consuming context faster than progress justifies? If yes, halt.

This is not optional reflection — it is a hard checkpoint. Skipping it is a session failure.

### Circuit breaker — hard stop

- 8 turns without conclusive state change = **STOP**.
- 16+ turns total in a single session = **STOP**, even if making progress — split the mission.
- Re-reading the same file twice in one session = **STOP** and grep instead.

When the breaker trips: append the cause via `{{PIPELINE_BIN}} progress-note {{PROJECT}} $CORRELATION_ID "<cause>"`, set pipeline stage to `manual` with a one-line reason, and notify. Do not push through.

### Success metric

Solving a task with fewer tokens is as valuable as solving it faster. The Governor will surface chronic over-spenders. Be one of the sessions it does not flag.

---

**Then read in full:**
- `{{PROJECT_ROOT}}\CLAUDE.md`
- The project CLAUDE.md listed in Project Context above
- Every plan file referenced in the Mission

**Conditional references:**
- **If this branch commits to CLAUDE repo infrastructure:** Read `{{PROJECT_ROOT}}\infrastructure-conventions.md` (git conventions, multi-step work protocol)
- **If using Slack bridge or developing on notifications:** Reference `{{PROJECT_ROOT}}\slack-integration.md` for infrastructure details

**Check for prior test reports.** Test reports may be in one of two places depending on whether the qa/ branch has been merged:

```bash
# 1. Standard test-reports dir (merged qa/ branches land here)
ls {{PROJECT_ROOT}}/test-reports/test-report-*{{FEATURE}}*.md 2>/dev/null

# 2. Publish branch in the single feature worktree (post-3b — pre-merge reports
#    live on {{TEST_PUBLISH_BRANCH}}, not in the dev-branch working tree).
if [ -d "{{WORKTREE}}" ] && git -C {{WORKTREE}} rev-parse --verify {{TEST_PUBLISH_BRANCH}} >/dev/null 2>&1; then
  # List reports reachable from the publish branch.
  git -C {{WORKTREE}} ls-tree -r --name-only {{TEST_PUBLISH_BRANCH}} -- test-reports/ 2>/dev/null \
    | grep "test-report-.*{{FEATURE}}" || true
  # To read one: git -C {{WORKTREE}} show {{TEST_PUBLISH_BRANCH}}:<path-from-above>
fi
```

There may be **multiple** reports for the same plan slug (each autonomous test run writes a unique corr_id-suffixed file). Read them as follows:

1. **Manual findings files** — filenames ending in `-manual.md`. These are written by the operator and are never overwritten by autonomous runs. Read **all** of them. Their findings are authoritative and take priority over anything in autonomous reports.
2. **Most-recent autonomous report** — all other matching files; sort by filename (lexicographic) and read the last one. This gives the latest QA verdict.

If **any** report records **QA Pass: false**, the bugs it describes ARE the work for this session — they take priority over any `(needs testing)` items in the plan. For each bug listed:
- If the bug is not already a line item in the plan's Current Status table, add it now (before writing any code).
- Fix the bug as part of this session's implementation.
- Do not chain to the next session until all bugs from the report and all manual findings are resolved.

If all reports record **QA Pass: true**, they are informational only — no action required.

**Check for prior reviewer feedback.** If you are running because a code-review session returned `needs_work`, the reviewer's report is the contract for what to fix this attempt. Post-3b the report lives on the publish side-branch in the single feature worktree until `/merge` lands it on master. Look in both places:

```bash
# 1. Standard reports dir (post-merge — only matters if a prior cycle landed)
ls {{PROJECT_ROOT}}/reports/review-report-*{{FEATURE}}*.md 2>/dev/null

# 2. Publish branch in the single feature worktree (pre-merge — most common
#    case for active bounces). The dance committed the report on
#    {{REVIEW_PUBLISH_BRANCH}}, not the dev branch — read via `git show`.
if [ -d "{{WORKTREE}}" ] && git -C {{WORKTREE}} rev-parse --verify {{REVIEW_PUBLISH_BRANCH}} >/dev/null 2>&1; then
  git -C {{WORKTREE}} ls-tree -r --name-only {{REVIEW_PUBLISH_BRANCH}} -- reports/ 2>/dev/null \
    | grep "review-report-.*{{FEATURE}}" || true
  # To read one: git -C {{WORKTREE}} show {{REVIEW_PUBLISH_BRANCH}}:<path-from-above>
fi
```

Read this row's `review_retries` from the pipeline DB:
```bash
{{PIPELINE_BIN}} rows \
    {{PROJECT}} --feature {{FEATURE}} --format json | head -50
```

If any review-report filenames matched, inspect each filename's `retry<N>` token and pick the file whose `<N>` equals `review_retries - 1`:

> **Why `review_retries - 1`:** The report is written *before* `review-complete` increments the counter. A report written when `review_retries=0` is named `retry0`; after the bounce, the DB shows `review_retries=1`. Always match on `review_retries - 1`, not `review_retries`.

- **If a matching report exists**: this is a re-spawn after a `needs_work` verdict. Read the matching report in full. **You MUST list each Concern from the report as a sub-bullet under your implementation plan with the specific action you intend to take to address it.** Re-implementing the same shape that was rejected wastes the retry budget and parks the row at `manual`. The reviewer's Concerns take priority over any new improvements you might want to add.

  > **Cost of a missed `[BLOCKER]`:** Each unresolved `[BLOCKER]` triggers another `needs_work` verdict, burning a retry. When `review_retries` reaches `review_retry_budget`, the row parks at `manual` and a human must intervene — all work since the last manual fix is stalled. Every `[BLOCKER]` from the report must be demonstrably fixed before you call `dev-complete`.
- **If filenames matched but no `<N>` equals `review_retries - 1`**: the reports are stale from earlier bounce cycles. Ignore.
- **If no report matched**: this is a fresh dev attempt (review_retries=0); proceed normally.

---

## Environment

**Orchestrator preflight:** if this session needs to start or restart the orchestrator (`watch_queue.py`), always run `--status` first:
```bash
python {{PROJECT_ROOT}}/scripts/watch_queue.py --status
```
Exit code 0 = already running — do not start a second instance. Only use `--force` if `--status` confirms the prior instance is stale or dead. Never use `Start-Process` in a loop.

---

## Authority

You have full autonomy to:
- Read any file in the repo
- Edit source files and plan files
- Run the compile / smoke check listed in Project Context
- Create feature branches and commit

You do NOT have authority to:
- Push to remote
- Merge to main
- Make changes outside the scope of the Mission
- Refactor, clean up, or improve anything not directly required by the Mission

---

## File path discipline

Two roots are provided in your session header:

- **Project root** (`Project root (tracked writes):`): use this for all file edits
  you intend to commit — `scripts/`, `templates/`, `commands/`, `CLAUDE.md`, plan
  files in `repos/{{PROJECT}}/plans/`. This is your worktree.
- **Shared state root** (`Shared state root:`): use this to read or write
  `repos/{{PROJECT}}/memory/`, `repos/{{PROJECT}}/pipeline.db`, `repos/{{PROJECT}}/sessions/`.
  Search the codebase via the `scout` MCP tools (`search`, `text_search`, `lookup_symbol`,
  graph tools) rather than grepping markdown indexes — see the `/scout` skill.

Never use the **Shared state root** (from your session header) as the base path for tracked file
writes — that path is for reading shared state only. Always use the **Project root** for edits
you intend to commit. Never derive a path via the CLAUDE.md symlink — use the explicit values
already provided in the session header.

---


## Rules

**Work to the plan.** The plan is the contract. Do not add features or improve
adjacent code. If you notice something worth fixing, add it to the plan's Open
Questions and move on. "Completed the mission and noted improvements for later"
is better than "went further and broke scope."

**Only touch files listed in the plan.** The plan's Files Changed section is the
complete list of files you may create, edit, or delete. Do not touch any other file
— even if it looks misplaced, temporary, or wrong. If you encounter a file outside
the plan's scope that needs attention, note it in Open Questions and move on.

**One phase per session.** If the plan file you have been given contains multiple
phases (sections labelled "Phase 1", "Phase 2", etc.), **stop immediately** — this
plan must be split into separate per-phase files before any implementation starts.
Write a note in the progress entry for `$CORRELATION_ID` (via `{{PIPELINE_BIN}} progress-note`) explaining the blocker and notify
the operator. Do not implement any phase of a multi-phase plan file.

**Verify branch before touching anything.** The orchestrator pre-creates a git worktree
already on the correct branch. At session start, verify:
```bash
git branch --show-current   # must output: autonomous/{{FEATURE}}
```
If the output does not match, stop immediately — write the mismatch to the progress entry for `$CORRELATION_ID` (via `{{PIPELINE_BIN}} progress-note`) and notify the operator. Never commit directly to `main`. Never create or switch branches manually — the worktree is pre-positioned.

**Sync with `{{TARGET_BRANCH}}` before any edits.** The branch may have been queued before earlier merges landed. Rebase onto current `origin/{{TARGET_BRANCH}}`:

```bash
git fetch origin {{TARGET_BRANCH}}
git rebase origin/{{TARGET_BRANCH}}
```

Three outcomes:

1. **Clean rebase:** continue with the mission. Append a one-line progress note: `rebase: clean onto origin/{{TARGET_BRANCH}}`.

2. **Conflicts, all in-scope:** if **every** conflicted file is listed in the plan's Files Changed section, attempt resolution — the plan describes what these files should look like, so the resolution is yours to make. After staging, run `git rebase --continue`. On a clean continue, append progress note: `rebase: resolved <N> in-scope conflicts`. Proceed.

3. **Conflicts out of scope OR resolution attempt fails:** abort and flag.
   ```bash
   git rebase --abort
   {{PIPELINE_BIN}} stage-set \
     {{PROJECT}} {{FEATURE}} dev --rebase-required 1
   ```
   Append progress note naming the conflicting files: `rebase: aborted, rebase_required=1, conflicts in src/foo.py and src/bar.py`. Then **continue with the mission** on the un-rebased branch — the work still gets done; the merger will refuse to merge until the operator rebases manually and clears the flag.

**CLAUDE infrastructure files require their own branch.** If your mission requires modifying
any of these CLAUDE repo files: `settings.json`, `setup-symlinks.ps1`, `scripts/`,
`indexing/`, `templates/`, `commands/` — do NOT commit those changes to CLAUDE/main.
Before touching any infrastructure file:

1. `cd {{PROJECT_ROOT}} && git checkout -b autonomous/{{FEATURE}}`
   (create off current CLAUDE/main — the repo is on main at session start)
2. Make infrastructure changes, commit to `autonomous/{{FEATURE}}`
3. Leave the branch open. Do not merge it. Include in your completion notification:
   "CLAUDE changes on `autonomous/{{FEATURE}}` — requires manual review and merge
   before this feature is fully live."

Knowledge base files (plan files, session files, test reports, memory files,
CLAUDE.md prose, pipeline-reference.md) may be committed to CLAUDE/main as normal.

**One process at a time.** Kill any existing process before starting a new one.
Use the kill command from Project Context.

**Truncate large Bash outputs.** Any command that may produce large output (installs, test runs, builds, long log tails) must be piped through `| head -100`. Never let raw `npm install`, `pytest -v`, or build stdout flood into context — only the summary matters.

**Record dead ends in the progress file.** When an approach fails, append a one-line note to the progress entry for `$CORRELATION_ID` (via `{{PIPELINE_BIN}} progress-note`) before trying the next approach. One sentence: what failed and why. Future sessions will not repeat the same dead ends.

**Commit after each plan item.** Include in every commit:
```bash
git commit -m "[${CORRELATION_ID}] Plan: {{FEATURE}} — <item description> ✓

Co-Authored-By: <model-name-and-version> <noreply@anthropic.com>"
```
The `$CORRELATION_ID` environment variable is set by the orchestrator. The correlation ID is
also embedded in the git author email (claude-agent@$CORRELATION_ID), enabling tracing through
the entire pipeline (queue → spawn → commit → merge).
Do not leave plan status updates for the merger — update the plan file itself before committing
each item (see "Update the plan as you go" below).

**Update the plan as you go.** Mark items `(needs testing)` when code is written,
`✓` only after smoke check confirms. Keep the Current Status section accurate. Plan
files are symlinked — edits modify the real file on disk but are not committed by the
project repo. The human commits them to `CLAUDE` at merge time. Edit them anyway.

**Before generating the next session, close all documentation gaps:**
- **Plan Current Status:** every `(needs testing)` item must be flipped to `✓` (smoke
  check passed) or left with an explicit note if genuinely uncertain. Update the status
  line at the top of the plan file.
- **Plan Open Questions:** remove any question that was resolved during implementation.
  Leave only questions that remain genuinely open.
- **CLAUDE.md:** for any CLAUDE.md that governs changed code, record new patterns,
  gotchas, or architectural decisions made during implementation. Do not defer this to
  the end of the session — if a pattern was corrected mid-implementation, it especially
  belongs recorded now.
- **Reference docs:** if the implementation changes pipeline behaviour, session
  behaviour, or any system described in `pipeline-reference.md`, update that file to
  match actual implemented behaviour.

The merger is a gate check, not a documentation sprint. If these steps are skipped,
the merger must do them — that is a session failure, not a handoff.

**Progress mark each step.** As you complete each step, mark it via `{{PIPELINE_BIN}} progress-mark {{PROJECT}} $CORRELATION_ID <N> in_progress` then `... <N> completed`. Delete the progress entry when fully done: `{{PIPELINE_BIN}} progress-delete {{PROJECT}} $CORRELATION_ID`.

**Update session file Artifacts.** Before notifying on completion, confirm the Artifacts section of the session file reflects what was actually built — correct branch name, correct plan file. If the session file has no Artifacts section, add one.

**Stop and leave a note when blocked.** If the plan does not resolve an ambiguity,
write the blocker into the plan's Open Questions and move to the next item.
If you cannot proceed at all (missing file, missing template, missing credential,
unresolvable dependency):

1. Write the blocker into the plan's Open Questions — this is the persistent record.
2. Set pipeline stage to `manual` so the operator can see it needs action:
   ```bash
   {{PIPELINE_BIN}} stage-set \
     {{PROJECT}} {{FEATURE}} manual \
     --notes "blocked: <one-line reason>"
   ```
3. Notify at `high` priority:
   ```bash
   {{PIPELINE_BIN}} notify \
     --title "🚧 Dev Blocked" \
     --message "[one-line description of what blocked]
• 🌳 \`autonomous/[feature]\`
• 🚧 [blocker reason]
• 📋 Action: [what the operator must do]
🔴 Parked at manual
" \
     --priority high
   ```
4. Delete the progress file and stop.

**Verify before marking done.** Run the smoke check. Where a test script exists,
run it. Check logs where behaviour can be confirmed there. Do not mark `✓`
without evidence.

**Diagnose before changing any threshold, timeout, or confidence value.** Do not
commit a change to a numeric constant (timeout, confidence, wait duration, retry
count) without stating in the commit message the specific observed evidence that
justifies the new value. "Timed out at 6s" is the symptom, not evidence. Evidence
is: what the log showed at the moment of failure and why the new value is correct.
If the root cause cannot be established, record it in the plan's Open Questions
and do not apply the change.

**If you finish the Mission early**, stop. Do not begin items from other plans.
If there is genuinely related cleanup within the same plan that was not listed,
it may be done and noted — but a different plan means a different session.
Write a completion summary to the progress entry for `$CORRELATION_ID` (via `{{PIPELINE_BIN}} progress-note`) and proceed to notify.

**Self-review before handoff.** Before calling `dev-complete`, run `/code-review` on your own branch to catch any `[BLOCKER]` issues you may have introduced or left unresolved:

```
/code-review autonomous/{{FEATURE}}
```

- If the self-review produces **no `[BLOCKER]` concerns** → proceed to `dev-complete`.
- If it surfaces any **`[BLOCKER]`** → fix them now, commit the fix, and re-run the self-review. Do not call `dev-complete` with a known `[BLOCKER]` outstanding.
- A clean self-review with a strong Pride section is the standard to aim for.

**Hand off to the next session.** After the final commit, generate the next
session file and requeue for the orchestrator. The orchestrator will spawn the
next session within 30 seconds. `dev-complete` decides the next session type
from the current pipeline shape (review, test, or whatever comes after dev).

**Hand off atomically** (generate session, queue pipeline, notify in one call):
   ```bash
   {{PIPELINE_BIN}} dev-complete \
       {{PROJECT}} {{PLAN_PATH}} {{FEATURE}} \
       --title "⚙️ Development Complete" \
       --message "$(cat <<'EOF'
[one-line headline — what was built. IMPORTANT: --title is always the literal string above; never put the feature name or headline in --title]
• 🌳 `autonomous/[feature]`
• [≤35 char item summary] ✔️
• [repeat per changed item]
• 🧪 [N passed, N skipped]
• 📢 [one sentence — what was built or what changed]
🟢 Queued for 'review'

EOF
   )"
   ```
   The `dev-complete` command atomically:
   1. Generates the next session file (review at present; whatever stage follows dev in the pipeline)
   2. Advances the pipeline row to `queued` with `type=<next-session> sessions/...` annotation
   3. Fires the notification

   Choose title, tags, and priority to reflect the outcome — you have full control.
   Tags are emoji shortcodes (e.g. `warning`, `x`, `white_check_mark`, `rocket`).
   Priority: `min` `low` `default` `high` `urgent` — use `high` for blockers.
   Include in the message: what was implemented, the branch name, any blockers or open items.

