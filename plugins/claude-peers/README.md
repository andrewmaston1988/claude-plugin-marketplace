# claude-peers

Peer discovery and real-time messaging between Claude Code sessions on one machine. Each session runs a stdio MCP server; a singleton localhost broker routes messages between them. A message sent to a peer appears in its console within a second as a `<channel source="claude-peers">` block.

## Pieces

| Piece | What it does |
|---|---|
| `bin/claude-peers.mjs mcp` | Per-session stdio MCP server — registers with the broker, polls for inbound messages, pushes them as channel notifications. Wired automatically by the plugin manifest. |
| Broker (`broker run`) | Singleton HTTP server on `127.0.0.1:7899` — peer registry + message queue, state in an atomic-write JSON file. Auto-started by the first session that needs it; **self-heals**: if it dies mid-session, the next broker call respawns it and retries. |

## Delivery: push or poll

Rendering a `<channel>` block requires this plugin in the session's `--dangerously-load-development-channels` allowlist. A session launched without it — commonly one routed through a third-party provider — silently drops every push aimed at it.

At handshake the server walks its process ancestry to the owning `claude` command and reads that flag off its argv. Allowlisted → the push instructions ship unchanged. Not allowlisted → the handshake additionally instructs the session to `CronCreate` a `*/3 * * * *` job calling `check_messages`, which drains the broker's held queue. Detection that fails for any reason resolves to *not allowlisted*: a needless poll costs a turn every three minutes, a missed push costs the message.

The flag is the only signal read. If a session that cannot render channels is nonetheless launched with the flag, it is indistinguishable from one that can, and it gets the push instructions.

## MCP tools

| Tool | Purpose |
|---|---|
| `list_peers` | Discover other sessions (`scope`: `machine` / `directory` / `repo`) |
| `send_message` | Message a peer by id — lands in their console immediately |
| `set_summary` | Publish a 1–2 sentence "what I'm working on", plus the directory you're working in (both required) |
| `check_messages` | Recover messages the broker is holding — including ones already pushed as a notification, so a push missed while idle is not lost |

### Reading a peer row

```
ID: b381npjl
  PID: 53960
  CWD: C:/code/.worktrees/primordial/nursery-stage
  Checkout: C:/code/primordial
  Summary: primordial PORTER — nursery-stage IMPLEMENTED, all four plan steps written,
    workspace green. Now: mutation sweep, then fmt/clippy, then swarm review, then land.
  Summary set: 2026-08-23T16:12:04.310Z
  Last seen: 2026-08-23T17:52:19.882Z
```

**`Summary set` and `Last seen` are different facts, and the distinction is the point.** `Last seen` is the heartbeat — it advances every few seconds for as long as the session lives, so it tells you a peer is *alive* and nothing about whether what it says is still true. A summary left unchanged for hours sits beside a `Last seen` from ten seconds ago and reads as current. Only `Summary set` tells you it isn't. Re-call `set_summary` whenever your work changes; nothing else can refresh it.

**`CWD` is what the agent reported, not where it launched.** The registered directory is fixed when the MCP server spawns and the agent's own `cd` cannot move it — it runs in tool subprocesses. So a session that creates a git worktree mid-run would otherwise still report the checkout it started in, and peers could not tell which tree it is committing to. `set_summary` requires `cwd` for exactly this reason; a session that has not set one yet falls back to the launch directory.

**`Checkout` stays the launch repo** even when `CWD` is a worktree: a worktree is its own git toplevel, so following it would split `scope: "repo"` across trees and stop a fleet working one repository from discovering each other.

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

State lives in `<stateDir>/claude-peers/peers-state-<port>.json` (port-scoped so a test broker never shares state with the real one); a corrupt state file is quarantined (renamed `.corrupt-<ts>`), never silently overwritten. `broker stop` shuts the broker down via its own `POST /shutdown` — no pid-based kills.

## Troubleshooting

```bash
curl http://127.0.0.1:7899/health         # {"status":"ok","peers":N}
node bin/claude-peers.mjs doctor
```

Ad-hoc senders (scripts, curl) are auto-registered on first `send-message`, so peers can reply to them; poll replies with `POST /poll-messages {"id":"<your-sender-id>"}`.

## Attribution

A from-scratch rewrite of [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) (MIT) with the same tool surface and wire protocol, re-implemented as zero-dependency Node ESM with Windows-lifecycle hardening (no `HOME` dependence, detached broker, mid-session self-heal, ad-hoc sender replies). The upstream MIT notice ships verbatim as [`LICENSE.upstream`](./LICENSE.upstream).
