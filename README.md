# Claude Plugin Marketplace

A collection of [Claude Code](https://claude.ai/code) plugins.

## Plugins

| Plugin | Description | Status | Docs |
|--------|-------------|--------|------|
| checkpoint | Durable cross-session handoff via STATE.md. /checkpoint skill, SessionStart resume offer, PreCompact backstop, observable cache-keepalive | beta | [Setup guide](./plugins/checkpoint/README.md) |
| slack-bridge | Two-way Slack ↔ Claude Code bridge via Socket Mode | beta | [Setup guide](./plugins/slack-bridge/README.md) |
| pipeline | Pipeline orchestrator — queue plans, autonomous dev/test/review sessions, TUI + web dashboards, spend governance, conversational setup/demo subcommands | beta | [Setup guide](./plugins/pipeline/README.md) |
| swarm | Alternative-model fan-out engine — manifest-driven parallel runs across capable :cloud models and Claude, with digest compression and worktree isolation | beta | [Setup guide](./plugins/swarm/README.md) |
| claude-peers | Peer discovery and real-time messaging between local Claude Code sessions — per-session stdio MCP server plus a self-healing singleton localhost broker | beta | [Setup guide](./plugins/claude-peers/README.md) |
| agent-investigation | Investigate agent transcripts — locate, summary, errors, retries, pivots, report | beta | [Setup guide](./plugins/agent-investigation/README.md) |
| discipline | Per-model discipline deltas injected on every prompt (Sonnet 5 first), with baseline scanner and blind judge grader for measuring violation rates | beta | [Setup guide](./plugins/discipline/README.md) |
| voice | Per-operator dictionary mined from their own transcripts — cues injected only on a matching prompt, plus a SessionStart profile; nothing operator-specific ships in the plugin | beta | [Setup guide](./plugins/voice/README.md) |

## Using the marketplace

Register this marketplace once per machine:

```bash
claude plugin marketplace add andrewmaston1988/claude-plugin-marketplace
```

Then install any plugin by name:

```bash
claude plugin install slack-bridge@andrewmaston1988-claude-plugins
```

Or load for a single session without installing:

```bash
claude --plugin-dir /path/to/claude-plugin-marketplace/plugins/slack-bridge
```

## Contributing

Each plugin lives under `plugins/<name>/`. Add a `README.md` with setup instructions and a `plugin.json` manifest. See `plugins/slack-bridge/` as a reference.
