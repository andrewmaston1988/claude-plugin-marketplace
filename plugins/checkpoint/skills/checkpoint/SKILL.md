---
name: checkpoint
description: >-
  Use when capturing a durable session handoff to STATE.md so work resumes cleanly in a fresh session. Triggers — "/checkpoint", "/checkpoint:checkpoint", "snapshot state", "save a handoff", "checkpoint before I stop", or any checkpoint-plugin hook nudge (context pressure, post-compact pickup, Stop-hook write-up). SKIP for: trivial/short sessions where STATE.md adds nothing; routine `/compact`; the CLI's built-in checkpoint/rewind feature, which is unrelated to this skill.
---

# checkpoint — durable session handoff

Writes (or reconciles) a structured `STATE.md` so a *fresh session* can resume this work with zero re-explanation. STATE.md persists to disk — it survives terminal close, crash, next-day resume, and compaction. This is a handoff artifact, not a compaction helper.

## Workflow

1. **Read the format** in `templates/state-template.md` (relative to this skill dir). The 7-section shape is **rigid** — do not add or drop sections.

2. **Compute the path.** `~/.claude/projects/<encoded-cwd>/STATE_<slug>_<sessionId>_<YYYYMMDDTHHMMSSZ>.md`, where `<encoded-cwd>` is the cwd with `\`, `/`, `:` all rewritten to `-` (e.g. `C:/code/foo` → `C--code-foo`) and `<slug>` is a short kebab-case task descriptor (2–4 words, e.g. `checkpoint-limits`) so the file is recognisable when browsing. Mint new files with a slug; if a file already exists for your sessionId keep its existing name (the slug — or its absence on PreCompact skeletons — is preserved; only the stamp advances). When replacing a skeleton wholesale you may write a fresh slugged file and delete the skeleton. The filename is **per-session** — only your own sessionId owns the file. The embedded `YYYYMMDDTHHMMSSZ` is the canonical "freshness" signal: `resolveLatestStatePath` (in `plugins/checkpoint/hooks/lib/paths.mjs`) compares stamps embedded in filenames, not file mtimes, so a stale filename invites a parallel session's newer file to win even when yours is fresher. Override via `CLAUDE_STATE_PATH`.

   **Every successful checkpoint write must end with the file living at a filename whose embedded timestamp is the current UTC moment:**
   - If no STATE file exists for your sessionId → mint with the current UTC stamp.
   - If a STATE file already exists for your sessionId → reconcile the content, **write the new content into the existing filename first**, then `renameStateToNow(oldPath, new Date())` so the embedded stamp advances. The sessionId portion of the filename does not change. Recommended ordering (atomicity): write into the existing path, then rename — if the rename fails, the freshest content is still preserved at the old name. Use `renameStateToNow` from `plugins/checkpoint/hooks/lib/paths.mjs` (canonical helper) rather than re-implementing the regex split.

3. **File substantial content in the docs dir, don't inline it.** The STATE path resolved in step 2 has a sibling docs dir whose name comes from `docsDirForStatePath(statePath)` (in `plugins/checkpoint/hooks/lib/paths.mjs`) — join that name with the STATE file's directory. Before writing more than a few lines of durable rationale into any section (design decisions, investigation narrative, a nuanced decision log), lazily create the docs dir (`fs.mkdirSync(docsDir, {recursive:true})`) and write the write-up to `<docs-dir>/<free-form-name>.md`, then reference it in STATE.md as `path — one-line hook` (the KEY FILES idiom). Short facts still collapse to one-liners or filenames exactly as today. Record the docs dir path in the `docs:` header field; omit the field when nothing substantial is filed. Free-form filenames, no cap — trust your judgement on when a doc is warranted and what to call it.

4. **Read any existing STATE.md, then branch — reconcile, don't rewrite:**
   - **Absent** → write fresh, all sections.
   - **PreCompact skeleton** (contains `Skeletal backstop written by pre-compact-snapshot.mjs`) → replace wholesale with a rich version.
   - **Prior rich checkpoint** → **reconcile**: scan each section against current reality, correct stale claims (a "done" item now done, a next-action already taken), add new facts, and leave still-true `[stable]` content **verbatim**. Do not churn unchanged sections.

5. **Fill the header**: `branch` from `git rev-parse --abbrev-ref HEAD` (plus `git status --porcelain` → clean/dirty); `resume:` = the single first action (mirror NEXT ACTIONS #1); `docs:` = the sibling docs dir path if any docs were filed this turn (else omit).

6. **Copy the resume prompt.** Build a one-line handover and put it on the clipboard so the user can paste it into the fresh session instead of typing it:

   `Resume from the STATE handover: read "<abs STATE.md path>" and continue from its resume: action.`

   Windows: `Set-Clipboard` (or pipe to `clip`); macOS: `pbcopy`; Linux: `xclip -selection clipboard`. If no clipboard tool is available, print the line for manual copying.

7. **Tell the user**: `STATE.md saved at <path>. Resume prompt copied to the clipboard — paste it into a fresh session to resume.`

## Companion hooks (auto-wired by the plugin)

| Hook | What it does |
|---|---|
| **PreCompact** | Writes a skeletal STATE.md backstop before auto-compaction; leaves a marker. Never blocks. |
| **UserPromptSubmit** | Nudges you to invoke this skill when context utilisation crosses the 85%/95% bands; consumes the post-compact marker; runs the opt-in keepalive. |
| **SessionStart** | On a fresh start with an existing STATE.md, offers to resume. |
| **Stop** | After a turn that lands substantial uncaptured work (commit, or many file edits), blocks the stop once and asks you to judge: significant feature completed → invoke this skill and write up what was completed; otherwise just stop. |

Optional cache keepalive: set `checkpoint.keepalive: true`. See the plugin README.

## Anti-patterns

- **Rewriting from scratch when a rich STATE.md exists.** Reconcile — preserve valid nuance; only touch what changed.
- **Adding or dropping sections.** The 7-section format is exact; drift breaks the resume contract.
- **Dumping whole files into KEY FILES.** `path:line` pointers plus critical signatures only.
- **Inlining a long write-up that belongs in the docs dir.** STATE.md stays pointers-only; file substantial durable content (design rationale, investigation narrative, a nuanced decision log) under the sibling `-docs/` dir and link it as `path — one-line hook`.
- **Writing to the wrong path.** Always use the `<encoded-cwd>` rule (or `CLAUDE_STATE_PATH`).
- **Leaving a stale filename timestamp after a reconcile.** The SessionStart resume picker compares timestamps embedded in filenames, not mtimes — a frozen stamp invites a parallel session's newer file to win even when yours is fresher. Always call `renameStateToNow(oldPath, new Date())` after writing.
