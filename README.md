# Claude Plugin Marketplace

A collection of [Claude Code](https://claude.ai/code) plugins.

## Plugins

| Plugin | Description | Status | Docs |
|--------|-------------|--------|------|
| slack-bridge | Two-way Slack ↔ Claude Code bridge via Socket Mode | beta | [Setup guide](./plugins/slack-bridge/README.md) |

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
