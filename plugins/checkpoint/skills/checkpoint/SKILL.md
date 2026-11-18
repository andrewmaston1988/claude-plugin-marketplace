---
name: checkpoint
description: >-
  Use when capturing a durable session handoff to STATE.md so work resumes cleanly in a fresh session. Triggers — "/checkpoint", "/checkpoint:checkpoint", "snapshot state", "save a handoff", "checkpoint before I stop", or any checkpoint-plugin hook nudge (context pressure, post-compact pickup, Stop-hook write-up). SKIP for: trivial/short sessions where STATE.md adds nothing; routine `/compact`; the CLI's built-in checkpoint/rewind feature, which is unrelated to this skill.
---

# checkpoint — durable session handoff

Writes a structured `STATE.md` as a **full reconcile** so a *fresh session* can resume this work with zero re-explanation. Every checkpoint re-reads the existing file in full and rewrites what is no longer true — advancing only the `resume:` line and the stamp is the defect this skill exists to prevent, because a section left stale sends the resuming agent digging through transcripts and git archaeology. STATE.md persists to disk — it survives terminal close, crash, next-day resume, and compaction. This is a handoff artifact, not a compaction helper.

## Workflow

1. **Read the existing file in full, every page.** Compute the path first: `~/.claude/projects/<encoded-cwd>/STATE_<slug>_<sessionId>_<YYYYMMDDTHHMMSSZ>.md`, where `<encoded-cwd>` is the cwd with `\`, `/`, `:` all rewritten to `-` (e.g. `C:/code/foo` → `C--code-foo`) and `<slug>` is a short kebab-case task descriptor (2–4 words, e.g. `checkpoint-limits`) so the file is recognisable when browsing. The filename is **per-session** — only your own sessionId owns the file. If the Read is truncated by the token cap, keep Reading with offset until every line is covered — never reconcile from a partial view. No file for your sessionId → you are minting one (name it with the current UTC stamp). Override via `CLAUDE_STATE_PATH`.

2. **Rewrite every `[live]` section from current reality.** CURRENT STATE, NEXT ACTIONS and KEY FILES are re-checked against what is true *as of this checkpoint*, every time. No prior file → write all sections. A PreCompact skeleton (contains `Skeletal backstop written by pre-compact-snapshot.mjs`) → replace wholesale with the rich version. Read the format in `templates/state-template.md` (relative to this skill dir) before the first write — the 7-section shape is **rigid** (do not add or drop sections) and it states the header caps and the size budget.

3. **Keep `[stable]` sections verbatim unless a fact moved.** OBJECTIVE, CONSTRAINTS & DECISIONS, ENV & COMMANDS and OUT OF SCOPE survive this checkpoint unchanged when their facts still hold. Do not churn `[stable]` sections — but "unchanged" never applies to a `[live]` one.

4. **Header fields are one line and never a log; history belongs to git and the plan.** `branch` from `git rev-parse --abbrev-ref HEAD` (plus `git status --porcelain` → clean/dirty); `session:` = a one-line continuation description; `resume:` = the start of NEXT ACTIONS item 1 (mirror it — a new resume line atop a stale list fails the lint); never append `[~HH:MM LATEST]` notes to a header field. `docs:` = the sibling docs dir path if any docs were filed this turn (else omit).

5. **File narrative into the docs dir and link it; link every doc already there.** The STATE path has a sibling docs dir named by `docsDirForStatePath(statePath)` (in `plugins/checkpoint/hooks/lib/paths.mjs`) — join that name with the STATE file's directory. Before more than a few lines of durable rationale (design decisions, investigation narrative, a nuanced decision log) land in any section, lazily create the docs dir (`fs.mkdirSync(docsDir, {recursive:true})`) and write the write-up to `<docs-dir>/<free-form-name>.md`, then reference it in STATE.md as `path — one-line hook` (the KEY FILES idiom). Every file already in the docs dir is named under KEY FILES the same way, or moved out of the dir — an unlinked doc fails the lint. Long rationale, lengthy narrative → file, don't inline; the STATE stays small enough for one Read.

6. **Run the `stampState` helper as a CLI:** `node "../../hooks/lib/paths.mjs" stamp <path>` (paths relative to this skill dir). It writes `saved:` from the clock (as `YYYY-MM-DD HH:MM UTC`, never by hand) and advances the filename stamp atomically, replacing the old write-then-`renameStateToNow` sequence. Then run the lint, `node "../../hooks/lib/state-lint.mjs" <path>`, and fix every error it names until it exits 0.

7. **Only then tell the user it is saved:** `STATE.md saved at <path>. Resume prompt copied to the clipboard — paste it into a fresh session to resume.` Build that one-line handover first and put it on the clipboard so it can be pasted instead of typed: `Resume from the STATE handover: read "<abs STATE.md path>" and continue from its resume: action.` Windows: `Set-Clipboard` (or pipe to `clip`); macOS: `pbcopy`; Linux: `xclip -selection clipboard`. If no clipboard tool is available, print the line for manual copying. Before the lint exits 0 the file is not saved — fix it first.

## Companion hooks (auto-wired by the plugin)

| Hook | What it does |
|---|---|
| **PreCompact** | Before auto-compaction: with a full checkpoint, writes a `precompact-<stamp>.md` snapshot into its docs dir and never touches the checkpoint; with none, writes the skeletal STATE.md. Either way it prints summary instructions on stdout, and it never blocks. |
| **UserPromptSubmit** | Nudges you to invoke this skill when context reaches the `soon`/`now` bands, measured against this session's real compaction point rather than a percentage of the model window; runs the opt-in keepalive. |
| **PostToolUse** | The same nudge mid-turn, so a band also lands between prompts. |
| **SessionStart** | On a fresh start, hands over the newest STATE files (if any) and has you offer to resume. |
| **PreToolUse** | Holds an acting tool while a resumed STATE file is still partly unread, naming the next `offset` to Read, and blocks a Write/Edit whose STATE fails the lint. `Read`, `Grep`, `Glob`, `Skill`, `ToolSearch`, `AskUserQuestion`, the `Task*` tools and most `mcp__scout__*` calls always pass; fails open. |
| **Stop** | After a turn that lands substantial uncaptured work (a commit, many file edits, or answered operator questions), blocks the stop once and asks you to judge: significant feature completed → invoke this skill and write up what was completed; otherwise just stop. |

Optional cache keepalive: set `checkpoint.keepalive: true`. See the plugin README.

## Anti-patterns

- **Appending to a header field.** `resume:`, `session:` and `saved:` are one-line fields — a `[~HH:MM LATEST]` chain is the exact shape that fooled the resume picker and its own session.
- **Updating only the resume line.** A stamp advanced and a resume line rewritten over a stale list is the failure mode; the lint and the Stop hook both bounce it.
- **Writing `saved:` by hand.** `stampState` writes it from the clock; a hand-written value drifts from the filename stamp (observed: two sessions wrote a wrong one).
- **A script that rewrites the header and renames.** The append-note-then-`renameStateToNow` pattern silently skips the reconcile and defeats every check — hooks stood down on the stamp, not on truth.
- **Gutting a rich STATE's `[stable]` sections on reconcile.** Rewrite the `[live]` sections; keep `[stable]` content verbatim — only touch what a moved fact invalidated.
- **Adding or dropping sections.** The 7-section format is exact; drift breaks the resume contract.
- **Dumping whole files into KEY FILES.** `path:line` pointers plus critical signatures only.
- **Inlining a long write-up that belongs in the docs dir.** STATE.md stays pointers-only; file substantial durable content (design rationale, investigation narrative, a nuanced decision log) under the sibling `-docs/` dir and link it as `path — one-line hook`.
- **Leaving docs-dir files unlinked.** A doc the STATE never names fails the lint; name it under KEY FILES or move it out of the dir.
- **Writing to the wrong path.** Always use the `<encoded-cwd>` rule (or `CLAUDE_STATE_PATH`).
- **Leaving a stale filename timestamp after a reconcile.** The SessionStart resume picker compares timestamps embedded in filenames, not mtimes — a frozen stamp invites a parallel session's newer file to win even when yours is fresher. `stampState` owns the stamp; never rename manually.
