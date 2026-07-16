# claude-peers

Peer discovery and real-time messaging between Claude Code sessions on one machine. Each session runs a stdio MCP server; a singleton localhost broker routes messages between them. A message sent to a peer appears in its console within a second as a `<channel source="claude-peers">` block.

## Pieces

| Piece | What it does |
|---|---|
| `bin/claude-peers.mjs mcp` | Per-session stdio MCP server — registers with the broker, polls for inbound messages, pushes them as channel notifications. Wired automatically by the plugin manifest. |
| Broker (`broker run`) | Singleton HTTP server on `127.0.0.1:7899` — peer registry + message queue, state in an atomic-write JSON file. Auto-started by the first session that needs it; **self-heals**: if it dies mid-session, the next broker call respawns it and retries. |

## MCP tools

| Tool | Purpose |
|---|---|
| `list_peers` | Discover other sessions (`scope`: `machine` / `directory` / `repo`) |
| `send_message` | Message a peer by id — lands in their console immediately |
| `set_summary` | Publish a 1–2 sentence "what I'm working on" |
| `check_messages` | Manual poll fallback |

## CLI

```bash
node bin/claude-peers.mjs mcp             # stdio MCP server (what the manifest runs)
node bin/claude-peers.mjs broker start    # start the broker detached
node bin/claude-peers.mjs broker stop     # stop it (PID file)
node bin/claude-peers.mjs broker status   # health + peer count
node bin/claude-peers.mjs broker run      # foreground broker (debugging)
node bin/claude-peers.mjs doctor          # node version, config, broker health, state file
```

## Config

`<configDir>/claude-peers/config.json` (Windows: `%APPDATA%`, macOS: `~/Library/Application Support`, Linux: `$XDG_CONFIG_HOME`):

| Key | Default | Meaning |
|---|---|---|
| `port` | `7899` | Broker port (env override: `CLAUDE_PEERS_PORT`) |
| `pollIntervalMs` | `1000` | Inbound message poll cadence |
| `heartbeatIntervalMs` | `15000` | Peer liveness heartbeat |

State lives in `<stateDir>/claude-peers/peers-state.json`; a corrupt state file is quarantined (renamed `.corrupt-<ts>`), never silently overwritten.

## Troubleshooting

```bash
curl http://127.0.0.1:7899/health         # {"status":"ok","peers":N}
node bin/claude-peers.mjs doctor
```

Ad-hoc senders (scripts, curl) are auto-registered on first `send-message`, so peers can reply to them; poll replies with `POST /poll-messages {"id":"<your-sender-id>"}`.

## Attribution

A from-scratch rewrite of [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) (MIT) with the same tool surface and wire protocol, re-implemented as zero-dependency Node ESM with Windows-lifecycle hardening (no `HOME` dependence, detached broker, mid-session self-heal, ad-hoc sender replies). The upstream MIT notice ships verbatim as [`LICENSE.upstream`](./LICENSE.upstream).
