# agent-investigation Plugin

A Claude Code plugin for investigating agent transcripts and running subagent analysis.

## Installation

```bash
claude plugins install agent-investigation
```

## Usage

### CLI Entry Point

```bash
claude-investigate <subcommand> [args...]
```

#### Subcommands

- `locate <agent-id>` — Find the absolute path to an agent transcript JSONL
- `summary <agent-id>` — Print a one-page summary of the agent's transcript
- `errors <agent-id>` — List all errors encountered during execution
- `retries <agent-id>` — Identify retried tool calls
- `pivots <agent-id>` — Find planning/pivot moments (long-text blocks)
- `report <agent-id>` — Full investigation report
- `--help` — List all subcommands
- `doctor` — Check Python availability (≥3.9)

### Slash Command

```
/investigate <agent-id>
```

Runs a quick summary and suggests the next investigation subcommand based on findings.

### Python Dependency

This plugin requires Python ≥ 3.9 on PATH. The plugin checks this with the `doctor` subcommand.

If Python is not found, set the `PIPELINE_PYTHON` environment variable to the path of your Python executable:

```bash
export PIPELINE_PYTHON=/path/to/python3
claude-investigate doctor
```

## Architecture

- `bin/claude-investigate.mjs` — CLI dispatcher
- `scripts/transcript_mine.py` — Core investigation logic (vendored from CLAUDE repo)
- `scripts/locate-agent.mjs` — Agent transcript path resolution
- `src/paths.mjs` — Platform-specific directory helpers
- `src/index.mjs` — Runtime exports
- `skills/subagent-investigation/` — Skill definition (shipped with plugin)
- `commands/investigate.md` — Slash command handler

## Development

Run tests:

```bash
node --test plugins/agent-investigation/tests/*.test.mjs
```

## License

MIT
