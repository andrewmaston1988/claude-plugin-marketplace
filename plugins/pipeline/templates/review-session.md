# Review Session — {{FEATURE}}

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

Invoke `{{REVIEW_SKILL}}` against the source branch, write the structured report to the code-review worktree, then call `{{PIPELINE_BIN}} review-complete`. One session reviews one feature.

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

### Circuit breaker — hard stop

- 8 turns without conclusive state change = **STOP**.
- 16+ turns total in a single session = **STOP**, even if making progress — split the mission.
- Re-reading the same file twice in one session = **STOP** and grep instead.

When the breaker trips: append the cause via `{{PIPELINE_BIN}} progress-note {{PROJECT}} $CORRELATION_ID "<cause>"`, set pipeline stage to `manual` with a one-line reason, and notify. Do not push through.

---
**Then read in full:**
- `{{PROJECT_ROOT}}\CLAUDE.md`
- The project CLAUDE.md listed in Project Context above
- The plan file at the Plan file path above
- `{{PROJECT_ROOT}}\skills\code-review\principles.md` — the 24 principles you will apply
- `{{PROJECT_ROOT}}\skills\code-review\SKILL.md` — the framing and output format

**Conditional references:**
- **If the diff touches a `CLAUDE.md`:** Read `{{PROJECT_ROOT}}\skills\claude-author\SKILL.md` — its 5 gates are the review lens for CLAUDE.md edits.
- **If the diff touches a `skills/<name>/SKILL.md`:** Read `{{PROJECT_ROOT}}\skills\skill-author\SKILL.md` — its 5 gates are the review lens for skill edits.
- **If the diff touches files governed by a project CLAUDE.md:** Read that project's CLAUDE.md to judge convention adherence.
- **If using Slack bridge or notification infrastructure:** Reference `{{PROJECT_ROOT}}\slack-integration.md` for notification details (relevant if a Concern names a Slack-bridge or notify-path bug).

---

## Authority

You have full autonomy to:
- Read any file in the project repo or CLAUDE repo
- Run `git diff`, `git log`, `git status` against the project repo
- Run `git worktree add` against the CLAUDE repo
- Invoke the `/code-review` skill
- Run `{{PIPELINE_BIN}} rows` to read the pipeline row
- Run `{{PIPELINE_BIN}} review-complete` to finalize
- Write the **single** review-report file via **Bash heredoc** into the code-review worktree

You do NOT have authority to:
- Edit any source file (the Write/Edit tools are not in your tool surface — by design)
- Edit any plan file
- Commit to the project repo
- Commit to any branch other than `code-review/{{FEATURE}}` in the CLAUDE repo
- Make any change to the codebase under review
- Push to a remote

**Your job is to read, judge, and report — not to fix.**

---

## Rules

**Verify the source branch exists.** Before reviewing, confirm:

```bash
cd {{CWD}}
git rev-parse --verify autonomous/{{FEATURE}}   # must succeed
```

If the branch is missing, exit with `--verdict needs_work` and a Concern naming the absent branch — there is nothing to review.

**Read `review_retries` AND `review_retry_budget` from the pipeline row.** The retry number is embedded in the report filename so successive cycles for the same feature don't collide; the budget is needed for the notify title (`retry N+1/budget`). Run:

```bash
{{PIPELINE_BIN}} rows \
    {{PROJECT}} \
    --feature {{FEATURE}} --format json | head -50
```

Parse the JSON output and extract `review_retries` (integer) and `review_retry_budget` (integer). Define **two shell variables** you will reference downstream — same shell-variable convention as `REPORT_PATH` (defined below) to avoid drift between this step and the notify title:

```bash
N=<review_retries value you just read>           # e.g. N=1
BUDGET=<review_retry_budget value you just read>  # e.g. BUDGET=3
RETRY_LABEL="$((N+1))/$BUDGET"                    # bash builds "2/3"
```

Use `$N` as `<N>` in the report filename (heredoc below); use `${RETRY_LABEL}` in the notify title (further below). Confirm in your reasoning the values you read and what `${RETRY_LABEL}` evaluates to. **Never type `<budget>` literally** in the notify title — the agent who forgets to fill it produces `(retry 1/budget)` instead of `(retry 1/3)`.

**Read prior review reports (if any).** When `$N > 0`, previous review cycles exist. Read each prior report so you know what was flagged before and can verify whether the dev actually addressed it:

```bash
# Pre-merge: reports written by prior review cycles into the code-review worktree.
if [ -d "{{CODE_REVIEW_WT}}" ]; then
  ls {{REVIEW_REPORTS_DIR}}/review-report-*{{FEATURE}}*.md 2>/dev/null
fi

# Post-merge: same reports landed under the project's own reports dir.
ls {{PROJECT_ROOT}}/reports/review-report-*{{FEATURE}}*.md 2>/dev/null
```

Read every report whose `retry<K>` token satisfies `K < $N`. For each prior `[BLOCKER]` concern, note whether the diff shows a credible fix. Tally the outcomes:

- **Resolved** — prior `[BLOCKER]` has a clear, correct fix in the diff.
- **Outstanding** — prior `[BLOCKER]` is present in the diff unchanged or inadequately addressed; flag it again as `[BLOCKER]` and **lead with a loud callout** that this concern was previously raised and still not fixed (e.g. *"[BLOCKER — raised in retry 1, still unresolved]"*).
- **New** — `[BLOCKER]` not present in any prior report.

Add a one-line prior-cycle summary as the first line of the Concerns section in your report:

```
**Prior-cycle summary:** X Resolved · Y Outstanding · Z New
```

(e.g. `**Prior-cycle summary:** 5 Resolved · 2 Outstanding · 2 New`)

If `$N == 0` (fresh first attempt), skip this step entirely — no prior-cycle summary line needed.

**The feature worktree already exists.** Phase 3b: one worktree per feature at `{{WORKTREE}}`. Do NOT run `git worktree add` — the orchestrator (or a prior session) created it. All report writes land in subdirectories of this worktree; the publish step below moves the commit onto a side-branch.

**Truncate large Bash outputs.** Any command that may produce large output (`git log`, `git diff` against a big branch) must be piped through `| head -200` or similar. Don't let raw diff output flood your context — the `/code-review` skill reads the diff itself; you don't need to inline the full content.

**Invoke `/code-review` against the source branch.** Default mode (not `--fresh` — your session is already fresh-context from the orchestrator's perspective). Pass the source branch as the skill's positional argument:

```
/code-review autonomous/{{FEATURE}}
```

The skill emits four sections (Concerns, Open questions, Pride, Verdict). Capture the entire output — you will paste it verbatim into the report file in the next step.

**Map `/code-review`'s verdict to the pipeline's two-value verdict.** The `/code-review` skill emits one of three verdicts; the pipeline accepts only two:

| /code-review skill verdict | Pipeline `--verdict` arg | When |
|---|---|---|
| `Ready to ship` | `ready_to_ship` | No `[BLOCKER]` or `[ABORT]` concerns — `[ADVISORY]`-only is still `ready_to_ship` |
| `Needs work` | `needs_work` | At least one `[BLOCKER]` concern — dev bounces back to fix |
| `Re-think the approach` | `abort` | At least one `[ABORT]` concern — row parks at manual immediately; human decides |

Anything other than `ready_to_ship` or `needs_work` passed to `review-complete` will be rejected with `[review-bad-verdict]`.

**Define the report path ONCE as a shell variable** — the path is used three times below (mkdir, heredoc target, `review-complete --report`, and in the notify message), and drift between any two of them causes a silent `Report not found` failure. **You MUST set `REPORT_PATH` in your shell session and reference `$REPORT_PATH` in every place it appears** — do not retype the path inline:

```bash
REPORT_PATH={{REVIEW_REPORTS_DIR}}/review-report-<date>-{{FEATURE}}-retry<N>-${CORRELATION_ID}.md
```

`{{REVIEW_REPORTS_DIR}}` is the absolute reports directory inside the code-review worktree; it's substituted by session-gen from a single config source so the reaper and the template can't drift. Never reconstruct this path inline — bash tool cwd resets between calls and a relative form would silently fail with `Report not found`.

**Write the report file via Bash heredoc** — your tool surface does NOT include `Write`. The heredoc delimiter MUST be single-quoted and unique (`'PIPELINE_REVIEW_REPORT_SENTINEL_END'`) so the report content (which may include `$` expansions, backticks, or accidental `EOF` strings) can't break the heredoc parser:

```bash
mkdir -p "$(dirname "$REPORT_PATH")"
cat > "$REPORT_PATH" << 'PIPELINE_REVIEW_REPORT_SENTINEL_END'
# Code Review Report: {{FEATURE}} (attempt <N+1>)

**Plan:** `{{PROJECT_ROOT}}/plans/{{FEATURE}}.md`
**Source branch:** `autonomous/{{FEATURE}}`
**Target branch:** `{{TARGET_BRANCH}}`
**Reviewer:** Claude (model pinned by orchestrator)
**Correlation ID:** ${CORRELATION_ID}

---

<paste the /code-review skill's full output here verbatim:
 Concerns, Open questions, Pride (if any), Verdict, plus the one-or-two
 sentence verdict explanation. Use the exact section structure /code-review
 produced.>

---

review_verdict: <ready_to_ship | needs_work>
PIPELINE_REVIEW_REPORT_SENTINEL_END
```

The trailing canonical `review_verdict:` line is **operator-facing only**. The orchestrator reads the verdict from the `--verdict` CLI arg in the next step, NOT by re-parsing this line. Make it match the `--verdict` value you will pass to `review-complete` for the operator's audit clarity.

**Publish the report to the `{{REVIEW_PUBLISH_BRANCH}}` branch (stash-switchback dance).** The single feature worktree is currently on `autonomous/{{FEATURE}}`. The report must land on its own side-branch so the merge skill can read the verdict from git history. Do the stash-switchback dance:

```bash
cd {{WORKTREE}}
# 1. Stash any uncommitted dev WIP (untracked + tracked).
git stash push -u -m "auto: code-review-{{FEATURE}}"
STASH_RC=$?
# 2. Create or fast-forward the publish branch.
git checkout -B {{REVIEW_PUBLISH_BRANCH}}
# 3. Stage and commit the report.
git add "$REPORT_PATH"
git commit -m "code-review: {{FEATURE}} retry${N}"
# 4. Return to the dev branch.
git checkout autonomous/{{FEATURE}}
# 5. Restore WIP (only if step 1 actually stashed something).
if [ "$STASH_RC" = "0" ] && git stash list | grep -q "auto: code-review-{{FEATURE}}"; then
  if ! git stash pop; then
    # Stash-pop conflict — park at manual; preserve the stash for operator recovery.
    {{PIPELINE_BIN}} stage-set {{PROJECT}} {{FEATURE}} manual \
      --notes "[stash-pop-conflict] code-review report published to {{REVIEW_PUBLISH_BRANCH}} but dev WIP could not be restored; stash preserved (git stash list)"
    {{PIPELINE_BIN}} notify --priority high \
      --title "🚨 Stash-pop conflict" \
      --message "code-review of {{FEATURE}} parked at manual: stash pop conflicted after report publish. Stash preserved; operator must run \`git stash list\` / \`git stash pop\` in {{WORKTREE}} to resolve."
    exit 0
  fi
fi
```

If any step before stash-pop fails the report is not published — that is a hard failure; do not call `review-complete`.

**Progress mark each step.** As you complete each step, mark it via `{{PIPELINE_BIN}} progress-mark {{PROJECT}} $CORRELATION_ID <N> in_progress` then `... <N> completed`. Delete the progress entry when fully done: `{{PIPELINE_BIN}} progress-delete {{PROJECT}} $CORRELATION_ID`.

**Finalize the review session, advance the pipeline, and notify.** Once the report is written, run `review-complete`. This is the atomic helper that commits the report to the code-review worktree, writes the verdict to the DB, advances the row, **and sends a notification** — all in one step. Choose `--priority` and `--title` based on verdict:

| Verdict | `--priority` | `--title` |
|---|---|---|
| `ready_to_ship` | `default` | `👥 Review Pass` |
| `needs_work` (within budget) | `default` | `🚨 Review Failed (retry ${RETRY_LABEL})` |
| `needs_work` (budget exhausted — helper sets this; agent doesn't pre-compute) | `high` | `🚨 Review Failed — budget exhausted` |
| `abort` | `high` | `🚨 Review Aborted` |

If you can't determine in advance which side of the budget you'll fall on, use the within-budget shape; the helper switches to the parked notification when it transitions the row to `manual`.

**Re-use `$REPORT_PATH`** in the review-complete `--report` flag and the notify message — same variable defined above, do not retype.

Use the message shape that matches the verdict:

**ready_to_ship:**
```bash
--message "$(cat <<EOF
[headline summarising quality]
• 🌳 \`autonomous/FEATURE\`
• 🎖 [one sentence from the /code-review Pride section — omit line if Pride was empty]
• ⁉️ [N] advisory (non-blocking)
• 📢 [one sentence on overall quality]
🟢 Queued for merge

EOF
)"
```

**needs_work (within budget):**
```bash
--message "$(cat <<EOF
[critical blocker in brief]
• 🌳 \`autonomous/FEATURE\`
• 🚧 [N] blocker(s) · [N] advisory
• ⚠️ [one-line distillation of the most critical BLOCKER]
• 📢 [one sentence — pattern of failures or what still needs fixing]
🟡 Returned to 'dev'

EOF
)"
```

**needs_work (budget exhausted — use within-budget shape; helper overrides title/tags/priority):**
```bash
--message "$(cat <<EOF
[recurring blocker in brief]
• 🌳 \`autonomous/FEATURE\`
• 🚧 [N] blocker(s) · retry ${RETRY_LABEL}
• ⚠️ [one-line distillation of the recurring BLOCKER]
• 📢 [one sentence — why this is stuck]
🔴 Parked at manual

EOF
)"
```

**abort:**
```bash
--message "$(cat <<EOF
[approach issue in brief]
• 🌳 \`autonomous/FEATURE\`
• 🚧 [one-line distillation of the ABORT concern]
• 📢 [one sentence — why the approach is structurally wrong]
🔴 Parked at manual

EOF
)"
```

```bash
cd {{CWD}}
{{PIPELINE_BIN}} review-complete \
    {{PROJECT}} {{FEATURE}} \
    --report "$REPORT_PATH" \
    --verdict <ready_to_ship|needs_work|abort> \
    --correlation-id ${CORRELATION_ID} \
    --title "<title from table above>" \
    --message "$(cat <<EOF
<message body from matching shape above>
EOF
)"
```

(Note: the message heredoc delimiter is `EOF` — *unquoted* — so `$REPORT_PATH` expands. Distinct from the report-body heredoc above, where the delimiter is `'PIPELINE_REVIEW_REPORT_SENTINEL_END'` — *single-quoted* — to prevent `$` expansion inside the captured `/code-review` output.)

The helper atomically:
1. Validates the verdict string (rejects anything outside `{ready_to_ship, needs_work}` with `[review-bad-verdict]`).
2. Commits the report to the `code-review/{{FEATURE}}` worktree branch.
3. Writes the verdict to the DB's `review_verdict` column for this row.
4. Advances the pipeline:
   - `ready_to_ship` → row advances to `merge`; `review_retries` reset to 0.
   - `needs_work` AND `review_retries + 1 < review_retry_budget` → row bounces atomically (CAS) to `queued` with `type=dev`; `review_retries++`; `review_verdict` cleared back to NULL for the next cycle. The next dev session reads this report file on startup per the dev template's "prior feedback" rule.
   - `needs_work` AND budget exhausted → row parks at `manual` with `[parked-review-budget-exhausted <ts>]`; helper overrides the agent's `--title`/`--priority` to the parked variant so the operator sees the actual outcome regardless of what was pre-computed.
5. Sends the notification.

Exit code 0 means success and the pipeline is in the correct next state. Non-zero means an error — check stderr; the report file and pipeline row are recoverable.

**Do not push to a remote.** All commits stay local. The `/merge` step at the end of the feature lifecycle is what merges `code-review/{{FEATURE}}` into CLAUDE main.
