# voice — a dictionary of how one operator writes, built from their own transcripts

Every new session meets its operator cold. `voice` mines the messages a person has typed to Claude Code across all their projects and has a model build two things from them:

- **`cues.json`** — the parser. A list of concrete textual cues in the operator's own phrasing (a hedge that is really an instruction, a one-word reply that carries a verdict, a marker of a repeat request, a quoted-text-then-reaction shape…), each with what that shape means *from this person* and a one-line note to the assistant. A `UserPromptSubmit` hook runs them on every prompt and injects the notes **only when one fires**.
- **`profile.md`** — a reader's guide: register, what phrasing means, values, annoyances, how to respond. Injected once per session at `SessionStart`.

The plugin contains nothing about any particular operator. It is the procedure; the dictionary is generated per user, in whatever language they type in, and lives outside the plugin.

## Setup (once)

```bash
node <plugin-root>/bin/voice.mjs setup          # [--model sonnet]
```

1. **mine** — walks `~/.claude/projects/**/*.jsonl`, keeps only turns the operator authored (`origin.kind: human`; swarm leaves, subagents, `-p` sessions, tool results, hook injections and resumed-session duplicates are dropped), tags pasted content vs typed prose.
2. **sample** — a deterministic stratified sample across short / mid / long / longest turns, typed only.
3. **profile** — one `claude -p` call writes `profile.md`.
4. **cues** — one `claude -p` call, given the sample and the profile, writes the cue list. Each cue is then **validated against the whole corpus**: cues that don't compile, never fire, or fire on more than 35% of turns are dropped (recorded under `dropped` with the reason); kept cues carry their fire count, rate and example hits.

Read both files. Edit a note, or set `"enabled": false` on a cue you don't want. Start a new session. Needs ≥50 typed turns.

Re-run `setup` when the corpus has grown; `voice status` shows what is installed.

## Inspecting the dictionary

```bash
node <plugin-root>/bin/voice.mjs test                    # every cue: fires/total, meaning, note, example hits
node <plugin-root>/bin/voice.mjs test "some message"     # what would fire on this message
```

## Pieces

| What | Where |
|---|---|
| `bin/voice.mjs` | `setup`, `mine`, `sample`, `profile`, `cues`, `test`, `print-prompt`, `status` |
| `hooks/prompt-submit.mjs` | runs `cues.json` on each prompt; emits `<operator-cues>` on a match (max 3 notes); silent otherwise |
| `hooks/session-start.mjs` | injects `profile.md` on `startup`/`clear`; silent if no profile |
| `src/mine.mjs` | transcript walker + human-turn filter |
| `src/sample.mjs`, `src/distil.mjs`, `src/cues.mjs` | sampler, the two distillation prompts, cue validation and matching |

Neither hook ever blocks; every failure path exits 0 silently.

## Files

| Platform | profile.md, cues.json | turns.jsonl, sample.md, stats.json |
|---|---|---|
| Windows | `%APPDATA%\voice\` | same |
| macOS | `~/Library/Application Support/voice/` | same |
| Linux | `$XDG_CONFIG_HOME/voice/` | `$XDG_DATA_HOME/voice/` |

`VOICE_HOME` overrides both. `VOICE_TRANSCRIPTS` overrides the source directory.

## Use any model

`voice print-prompt` emits the profile prompt with the sample attached for pasting into another model; save the result as `profile.md`, then run `voice cues`.

## Kill switch

`CLAUDE_VOICE=off` in the environment disables both hooks.

## Tests

```bash
node --test plugins/voice/tests/*.test.mjs
```
