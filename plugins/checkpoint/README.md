# checkpoint

Durable cross-session **handoff** via `STATE.md`. Compaction is just one discontinuity; `STATE.md` persists to disk so a fresh session resumes cleanly.

## Pieces

1. **`/checkpoint` skill** — writes/**reconciles** a 7-section STATE.md (handoff artifact). Model-invocable; reconciles an existing file rather than rewriting it. Ends by copying a one-line resume prompt (referencing the STATE file) to the clipboard for pasting into the fresh session.
2. **SessionStart hook** — on a fresh start (`startup`/`clear`) with an existing STATE.md, offers to resume. Opt out: `checkpoint.sessionStartResume: false`.
3. **UserPromptSubmit hook** — nudges `/checkpoint` when context utilisation (from transcript `usage`, against the model's real window: 1M opus/fable, 200k sonnet/haiku) crosses the 85% and 95% bands — once each per window cycle, re-arming after compaction. Framed as a handover, not a stop-work order. Also consumes the post-compact marker and runs the opt-in keepalive.
4. **PreCompact hook** — skeletal STATE.md backstop before auto-compaction (the fallback when you don't checkpoint in time).
5. **Stop hook** — the *completion* checkpoint. When a turn ends after substantial uncaptured work (a `git commit`, or ≥10 file edits accumulated since the last checkpoint), it blocks the stop once and asks the model to judge: if a significant feature or milestone just completed, invoke `/checkpoint` and write up what was completed. Loop-safe (`stop_hook_active`), 15-min cooldown, and it stands down when the session's STATE stamp has advanced (the work is already captured). Opt out: `checkpoint.stopCheckpoint: false`.

## The loop

Context heavy → nudge → `/checkpoint` → start a fresh session → SessionStart offers resume → clean context.

## STATE.md location

`~/.claude/projects/<encoded-cwd>/STATE_<slug>_<sessionId>_<YYYYMMDDTHHMMSSZ>.md` (cwd with `\`, `/`, `:` rewritten to `-`; slug = short kebab-case task descriptor so files are recognisable when browsing — PreCompact skeletons omit it). One file per session, UTC-stamped — multiple sessions sharing a cwd no longer clobber each other. SessionStart offers the **most recent** `STATE_*` file as the resume candidate. Override with `CLAUDE_STATE_PATH`.

## Cache keepalive (opt-in)

Set in `~/.claude/settings.json`:

```json
{ "checkpoint": { "keepalive": true } }
```

The UserPromptSubmit hook owns a **self-correcting** cadence (target ~255s, jitter-aware) and logs each tick to `~/.claude/.checkpoint-keepalive.jsonl`. Verify with `/keepalive-status`.

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
├── hooks/                  PreCompact + UserPromptSubmit + SessionStart + Stop, lib/, templates/, tests/
├── statusline/cache-glyph.mjs
└── skills/
    ├── checkpoint/         the handoff skill + state-template.md
    └── keepalive-status/   the cadence + cache-bust audit
```

## Tests

```bash
cd checkpoint/hooks && npm test
```
