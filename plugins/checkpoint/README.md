# amag-checkpoint

Durable cross-session **handoff** via `STATE.md`. Compaction is just one discontinuity; `STATE.md` persists to disk so a fresh session resumes cleanly.

## Pieces

1. **`/checkpoint` skill** — writes/**reconciles** a 7-section STATE.md (handoff artifact). Model-invocable; reconciles an existing file rather than rewriting it.
2. **SessionStart hook** — on a fresh start (`startup`/`clear`) with an existing STATE.md, offers to resume. Opt out: `amag-checkpoint.sessionStartResume: false`.
3. **UserPromptSubmit hook** — nudges `/checkpoint` when context utilisation (from transcript `usage`) crosses ~75%; consumes the post-compact marker; runs the opt-in keepalive.
4. **PreCompact hook** — skeletal STATE.md backstop before auto-compaction (the fallback when you don't checkpoint in time).

## The loop

Context heavy → nudge → `/checkpoint` → start a fresh session → SessionStart offers resume → clean context.

## STATE.md location

`~/.claude/projects/<encoded-cwd>/STATE.md` (cwd with `\`, `/`, `:` rewritten to `-`). Override with `CLAUDE_STATE_PATH`.

## Cache keepalive (opt-in)

Set in `~/.claude/settings.json`:

```json
{ "amag-checkpoint": { "keepalive": true } }
```

The UserPromptSubmit hook owns a **self-correcting** cadence (target ~255s, jitter-aware) and logs each tick to `~/.claude/.amag-checkpoint-keepalive.jsonl`. Verify with `/keepalive-status`.

**Honest limit:** hooks fire only on prompts. During pure idle (machine sleep, a dropped tick) the chain can't self-re-arm until you return — `/keepalive-status` will show the gap.

## Cache state (ambient, not an alert)

A bust is irreversible — there is no escape hatch — so the plugin **prevents** (keepalive) and **measures**; it does not warn per-turn. Add the 🔥/❄️ + context% segment to your existing statusline command:

```bash
# append to your statusLine command:
node "<abs-path-to>/amag-checkpoint/statusline/cache-glyph.mjs"
```

## Layout

```
amag-checkpoint/
├── hooks/                  PreCompact + UserPromptSubmit + SessionStart, lib/, templates/, tests/
├── statusline/cache-glyph.mjs
└── skills/
    ├── checkpoint/         the handoff skill + state-template.md
    └── keepalive-status/   the cadence + cache-bust audit
```

## Tests

```bash
cd amag-checkpoint/hooks && npm test
```
