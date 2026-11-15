# checkpoint

Durable cross-session **handoff** via `STATE.md`. Compaction is just one discontinuity; `STATE.md` persists to disk so a fresh session resumes cleanly.

## Pieces

1. **`/checkpoint` skill** — writes/**reconciles** a 7-section STATE.md (handoff artifact). Model-invocable; reconciles an existing file rather than rewriting it. Ends by copying a one-line resume prompt (referencing the STATE file) to the clipboard for pasting into the fresh session.
2. **SessionStart hooks** — two, split by source. On a fresh start (`startup`/`clear`), hands over the 3 newest STATE files for this cwd — each with its slug, age and `session:` line — and asks the agent to offer them via `AskUserQuestion` alongside a "Start fresh" option. No time window: age is shown, not used to filter. Hooks cannot call `AskUserQuestion` themselves, so the hook supplies the options and the agent asks. On `compact`, **tells the session to read before it acts**: the note opens with "Read `<path>` in full before your next action. Then correct only what changed since its stamp; never rewrite a section from the summary." It then names the newest pre-compact snapshot and inlines the STATE file's header block and `NEXT ACTIONS` section verbatim, so the resume line and the ordered list survive even if the Read is skipped. Budgeted at 10,000 characters: the read-first sentence and the path always survive, the inline head is cut first (with a pointer to the file). A skeleton, or no STATE at all, still gets the reconcile-from-the-summary note. The harness event is what scopes this to the right session. Opt out (both): `checkpoint.sessionStartResume: false`.
3. **Context-pressure nudge — `UserPromptSubmit` and `PostToolUse`** — one decision (`lib/nudge.mjs`) run from both hooks, so a band also lands mid-turn, which is where an autonomous session actually compacts. It is measured in **tokens against this session's real compaction trigger**, not against the model's window. The window comes from `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, else `modelSettings.<model>.autoCompactWindow`, else top-level `autoCompactWindow`, each read local > project > user, and is capped at the model's own window where Claude Code's cached model catalog (`~/.claude/cache/model-catalog/*-cc.json`, `runtime.max_input_tokens`) states it, or at 1M for a `[1m]` id; Claude Code compacts about **33,000 tokens below** that window, so the trigger `T` is the window less the buffer; `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` can only lower it. A third-party model with no setting is assumed to be 200k. Two bands sit a **reserve** above the trigger: `soon` at `T − 2R` ("at your next natural pause") and `now` at `T − R` ("now, before your next tool call"). `R` is the room a checkpoint needs — default 60,000 tokens, `checkpoint.compactReserveTokens` to change it, clamped to `T/4` so the bands can never collapse or invert. Each band fires once per cycle: state is per-session in `~/.claude/.checkpoint-nudge/`, and the band itself is claimed by exclusive file create, so parallel `PostToolUse` processes and the two hooks together still produce exactly one nudge. The cycle re-arms after a compaction or a model switch. Framed as a handover, not a stop-work order. The `UserPromptSubmit` hook also runs the opt-in keepalive.

   **Cost:** `PostToolUse` runs on every tool call — a node spawn, the payload parse and a `stat`. Under 64 KiB of transcript growth since the last check it exits before reading the tail, the settings or the decision, and nothing is written unless a band fires. It never reads or writes the keepalive `STATE_DB`, and stays silent under `CORRELATION_ID`.
4. **PreCompact hook** — the backstop, fired once compaction is already under way, when there is no room left for a real handover. With no usable checkpoint it writes the skeletal STATE.md, as before. With a full checkpoint present it **never touches that file**: it writes `precompact-<UTC stamp>.md` beside it in the docs dir, carrying the last user and assistant text and the recent tool uses. Either way its stdout becomes instructions to the summariser — read the STATE file in full as the first action after compaction, the snapshot's path, and the STATE's `resume:` line — all inside a 10,000-character budget. It never blocks compaction.
5. **Stop hook** — the *completion* checkpoint. When a turn ends after substantial uncaptured work (a `git commit`, or ≥10 file edits accumulated since the last checkpoint), it blocks the stop once and asks the model to judge: if a significant feature or milestone just completed, invoke `/checkpoint` and write up what was completed. Loop-safe (`stop_hook_active`), 15-min cooldown, and it stands down when the session's STATE stamp has advanced (the work is already captured). Opt out: `checkpoint.stopCheckpoint: false`.

## The loop

Context filling → `soon` nudge at a natural pause → `/checkpoint` while the detail is still here → keep working, or start a fresh session → SessionStart offers resume → clean context.

If the session runs past `now` and compacts anyway, nothing is lost: PreCompact leaves a snapshot, the summary carries the read-first instruction, and SessionStart hands back the header and `NEXT ACTIONS` inline — so the handover is read, not rewritten from the summary.

## STATE.md location

`~/.claude/projects/<encoded-cwd>/STATE_<slug>_<sessionId>_<YYYYMMDDTHHMMSSZ>.md` (cwd with `\`, `/`, `:` rewritten to `-`; slug = short kebab-case task descriptor so files are recognisable when browsing — PreCompact skeletons omit it). One file per session, UTC-stamped — multiple sessions sharing a cwd no longer clobber each other. SessionStart offers the **3 most recent** `STATE_*` files as resume candidates, newest first. Override with `CLAUDE_STATE_PATH`. A sibling `<slug>_<sessionId>-docs/` dir (lazily created by the skill, named via `docsDirForStatePath`) holds substantial write-ups, linked from STATE.md as `path — one-line hook`.

## Cache keepalive (opt-in)

Set in `~/.claude/settings.json`:

```json
{ "checkpoint": { "keepalive": true } }
```

The UserPromptSubmit hook owns a **self-correcting** cadence (jitter-aware, target ~85% of the cache TTL) and logs each tick to `~/.claude/.checkpoint-keepalive.jsonl`. Verify with `/keepalive-status`.

**TTL detection:** the hook reads the live cache bucket from the transcript's `usage.cache_creation` breakdown (`ephemeral_5m` vs `ephemeral_1h`) on every tick, so a 1h-bucket session paces at ~51min and a 5m session at ~4min — including mid-session transitions (e.g. an overage drop back to 5m). All derived values scale with the detected TTL, notably the idle-stop (12× TTL: 1h at 5m, 12h at 1h — a 1h-bucket chain survives an overnight sleep). Overrides, both optional:

```json
{ "checkpoint": { "keepalive": true, "keepaliveTtlSecs": 3600, "keepaliveIdleStopSecs": 28800 } }
```

**Claude-model sessions only:** third-party providers expose no prompt-cache TTL, so there is no cache window to keep warm — sessions on a non-Claude model (per the transcript's newest assistant `model`) skip the keepalive entirely, even when opted in.

**Honest limit:** hooks fire only on prompts. During pure idle (machine sleep, a dropped tick) the chain can't self-re-arm until you return — `/keepalive-status` will show the gap.

## Cache state (ambient, not an alert)

A bust is irreversible — there is no escape hatch — so the plugin **prevents** (keepalive) and **measures**; it does not warn per-turn. Add the 🔥/❄️ + context% segment to your existing statusline command:

```bash
# append to your statusLine command:
node "<abs-path-to>/checkpoint/statusline/cache-glyph.mjs"
```

## Layout

```
checkpoint/
├── hooks/                  PreCompact + UserPromptSubmit + PostToolUse + SessionStart + Stop, lib/, templates/, tests/
├── statusline/cache-glyph.mjs
└── skills/
    ├── checkpoint/         the handoff skill + state-template.md
    └── keepalive-status/   the cadence + cache-bust audit
```

## Tests

```bash
cd checkpoint/hooks && npm test
```
