# agent-investigation Plugin

Investigate agent transcripts — locate, summarize, find errors, retries, pivots. Zero dependencies, Node 22+.

## Installation

```bash
claude plugins install agent-investigation
```

## Usage

### CLI Entry Point

```bash
claude-investigate <subcommand> [args...]
```

#### Agent-id subcommands (auto-locates transcript)

- `locate <id>` — Print path to agent's transcript JSONL
- `summary <id>` — One-page summary (size, tool freq, errors, retries)
- `errors <id>` — All errored tool calls with context
- `retries <id> [--window N]` — Retried tool calls (default window=5)
- `pivots <id> [--min-text-chars N]` — Long assistant texts (planning moments)
- `report <id> [--out FILE]` — Full investigation report (~30× compression)
- `tools <id> [--top N]` — Tool frequency table
- `ngrams <id> [--n N] [--top N]` — Tool N-gram patterns
- `agents <id>` — Agent tool dispatches (subagent runs)
- `skills <id>` — Skill invocations + preceding context
- `phases <id> [--text-threshold N]` — Auto-segmented work phases
- `sample <id> [--n N]` — Uniform-stride sample of events
- `scope <id> --worktree <path>` — File scope audit

#### File-path subcommands

- `sessions <dir>` — List all JSONL sessions with rollup stats
- `findings <a.jsonl> <b.jsonl>` — Contrastive overlap analysis
- `compare <a.jsonl> <b.jsonl>` — Tool trajectory diff
- `patterns <jsonl> [--out FILE]` — Candidate skill patterns (JSON)
- `slice <jsonl> --turn N [--ctx N]` — Extract turn ± context

### Slash Command

```
/investigate <agent-id>
```

Runs a quick summary and suggests the next investigation subcommand based on findings.

## Architecture

- `bin/claude-investigate.mjs` — CLI dispatcher
- `scripts/transcript-mine.mjs` — Core transcript analysis engine
- `scripts/locate-agent.mjs` — Agent transcript path resolution
- `src/paths.mjs` — Platform-specific directory helpers
- `skills/subagent-investigation/` — Skill definition (shipped with plugin)
- `commands/investigate.md` — Slash command handler

## Development

Run tests:

```bash
node --test plugins/agent-investigation/tests/*.test.mjs
```
