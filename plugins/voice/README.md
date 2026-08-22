# voice — an operator profile every session reads first

Every new session meets you cold. `voice` mines the messages you have typed to Claude Code across all your projects, distils them into a short profile — how you write, what your phrasing means, what you value, what annoys you, how to respond — and injects that profile at `SessionStart`.

It is the input-side counterpart of an output style: the style tells the model how to speak, the profile tells it how to read you. Language-agnostic — the profile is written in whatever language you type in.

## Setup (once)

```bash
node <plugin-root>/bin/voice.mjs setup
```

1. **mine** — walks `~/.claude/projects/**/*.jsonl`, keeps only turns you authored (`origin.kind: human`; swarm leaves, subagents, `-p` sessions, tool results, hook injections and resumed-session duplicates are dropped), tags pasted content vs typed prose.
2. **sample** — a deterministic stratified sample across short / mid / long / longest turns, typed only.
3. **profile** — one `claude -p --model sonnet` call over the sample writes `profile.md`.

Read the profile. Edit anything wrong — it is yours. Start a new session; the hook injects it as `<operator-profile>`.

Re-run `setup` when the corpus has grown. `voice status` shows what is installed. Needs ≥50 typed turns to run.

## Pieces

| What | Where |
|---|---|
| `bin/voice.mjs` | `setup`, `mine`, `sample`, `profile [--model]`, `print-prompt`, `status` |
| `hooks/session-start.mjs` | injects `profile.md` on `startup`/`clear` only; silent if no profile; never blocks |
| `src/mine.mjs` | transcript walker + human-turn filter |
| `src/sample.mjs`, `src/distil.mjs` | sampler and the single distillation call |

## Files

| Platform | profile.md | turns.jsonl, sample.md, stats.json |
|---|---|---|
| Windows | `%APPDATA%\voice\` | same |
| macOS | `~/Library/Application Support/voice/` | same |
| Linux | `$XDG_CONFIG_HOME/voice/` | `$XDG_DATA_HOME/voice/` |

`VOICE_HOME` overrides both. `VOICE_TRANSCRIPTS` overrides the source directory.

## Use any model

`voice print-prompt` emits the distillation prompt with the sample attached; paste it into whatever model you like and save the result as `profile.md`.

## Kill switch

`CLAUDE_VOICE=off` in the environment disables the hook.

## Tests

```bash
node --test plugins/voice/tests/*.test.mjs
```
