---
name: checkpoint
description: >-
  Use when capturing a durable session handoff to STATE.md so work resumes cleanly in a fresh session. Triggers — "/checkpoint", "snapshot state", "save a handoff", "checkpoint before I stop", or the UserPromptSubmit hook's context-pressure nudge. SKIP for: trivial/short sessions where STATE.md adds nothing; routine `/compact`.
---

# checkpoint — durable session handoff

Writes (or reconciles) a structured `STATE.md` so a *fresh session* can resume this work with zero re-explanation. STATE.md persists to disk — it survives terminal close, crash, next-day resume, and compaction. This is a handoff artifact, not a compaction helper.

## Workflow

1. **Read the format** in `templates/state-template.md` (relative to this skill dir). The 7-section shape is **rigid** — do not add or drop sections.

2. **Compute the path.** `~/.claude/projects/<encoded-cwd>/STATE_<sessionId>_<YYYYMMDDTHHMMSSZ>.md`, where `<encoded-cwd>` is the cwd with `\`, `/`, `:` all rewritten to `-` (e.g. `C:/code/foo` → `C--code-foo`). The filename is **per-session** — only your own sessionId owns the file. If a file already exists for your sessionId, write into it (preserve the original timestamp in the filename); otherwise mint a new one with the current UTC stamp. Override via `CLAUDE_STATE_PATH`.

3. **Read any existing STATE.md, then branch — reconcile, don't rewrite:**
   - **Absent** → write fresh, all sections.
   - **PreCompact skeleton** (contains `Skeletal backstop written by pre-compact-snapshot.mjs`) → replace wholesale with a rich version.
   - **Prior rich checkpoint** → **reconcile**: scan each section against current reality, correct stale claims (a "done" item now done, a next-action already taken), add new facts, and leave still-true `[stable]` content **verbatim**. Do not churn unchanged sections.

4. **Fill the header**: `branch` from `git rev-parse --abbrev-ref HEAD` (plus `git status --porcelain` → clean/dirty); `resume:` = the single first action (mirror NEXT ACTIONS #1).

5. **Tell the user**: `STATE.md saved at <path>. Start a fresh session here to resume from it.`

## Companion hooks (auto-wired by the plugin)

| Hook | What it does |
|---|---|
| **PreCompact** | Writes a skeletal STATE.md backstop before auto-compaction; leaves a marker. Never blocks. |
| **UserPromptSubmit** | Nudges you to invoke this skill when context utilisation crosses ~75%; consumes the post-compact marker; runs the opt-in keepalive. |
| **SessionStart** | On a fresh start with an existing STATE.md, offers to resume. |

Optional cache keepalive: set `checkpoint.keepalive: true`. See the plugin README.

## Anti-patterns

- **Rewriting from scratch when a rich STATE.md exists.** Reconcile — preserve valid nuance; only touch what changed.
- **Adding or dropping sections.** The 7-section format is exact; drift breaks the resume contract.
- **Dumping whole files into KEY FILES.** `path:line` pointers plus critical signatures only.
- **Writing to the wrong path.** Always use the `<encoded-cwd>` rule (or `CLAUDE_STATE_PATH`).
