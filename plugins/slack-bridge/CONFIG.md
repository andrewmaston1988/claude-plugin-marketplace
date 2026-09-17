# Slack-bridge configuration

## Env var ↔ config key mapping

The bridge resolves each token in two steps: env var first, then `config.json` fallback. Neither value is ever written to disk by the bridge itself.

| Env var | Config key | Required | Notes |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | `tokens.bot` | Yes | Bot token (`xoxb-…`). Used for all API calls. |
| `SLACK_APP_TOKEN` | `tokens.app` | Yes (Socket Mode) | App-level token (`xapp-…`). Required when running in Socket Mode. |
| `CLAUDE_CWD` | `claude.cwd` | No | Sets the working directory for the `claude` subprocess. Defaults to the directory where the bridge process was started. |

**Priority**: env var wins over config value. Setting `SLACK_BOT_TOKEN` in the shell overrides whatever is in `config.json`, so secrets can be injected at runtime without modifying any file on disk.

## Example config.json snippet

```json
{
  "tokens": {
    "bot": "xoxb-…",
    "app": "xapp-…"
  },
  "claude": {
    "cwd": "/home/user/myproject"
  }
}
```

For production deployments, prefer env vars for token values so they don't land in a config file that might be checked into version control.

## Model routing

The bridge agent runs on your Claude Code default model unless `claude.model` is set. Any non-Claude model name (e.g. an ollama `:cloud` tag) routes through the Anthropic-format endpoint in `proxy` — same mechanism as the pipeline plugin; the auth token is a pass-through placeholder (ollama auth rides the app's ambient signin). Change the config, restart the bridge, job done.

```json
{
  "claude": {
    "cwd": "/home/user/myproject",
    "model": "minimax-m3:cloud"
  },
  "proxy": {
    "url": "http://localhost:11434",
    "authToken": "ollama"
  }
}
```

Defaults: `claude.model` null (Claude default); `proxy.url` `http://localhost:11434`; `proxy.authToken` `"ollama"`. Claude models (`claude-*`, `haiku`, `sonnet`, `opus`, `fable`) never touch the proxy. The heartbeat's `slack.verbModel` is independent and stays on Claude.

## Remote control

`remote` configures the optional remote-control subsystem — see README → *Remote control* for the operator-facing flow. Remote control is **off** unless `remote.controlToken` is set (the `claude-slack setup` wizard writes it for you).

```json
{
  "remote": {
    "controlToken": "shared-secret-here",
    "brokerPort": 7898,
    "controlPort": 7897,
    "createChannels": false,
    "replyTimeoutMs": 120000,
    "replyPollIntervalMs": 1000
  }
}
```

| Key | Default | Notes |
|-----|---------|-------|
| `remote.controlToken` | `null` | Shared-secret bearer token guarding the localhost control endpoint. `null` disables remote control. The wizard generates one when left blank. |
| `remote.brokerPort` | `7898` | Internal localhost broker port. Distinct from `claude-peers`' 7899 on purpose, so the two subsystems don't collide if both run. |
| `remote.controlPort` | `7897` | Internal localhost control endpoint port. Localhost-only; the token is the auth boundary. |
| `remote.createChannels` | `false` | `true` → `/slack-remote` creates `#rc-<context-slug>` (requires `channels:write` + `channels:manage` on the bot token). `false` → DM-seize (no new scopes). |
| `remote.replyTimeoutMs` | `120000` | Per-message: how long the bridge waits for the live session's reply before posting "live session didn't reply in time". The claim is retained across a timeout (peer may be slow, not dead). |
| `remote.replyPollIntervalMs` | `1000` | How often the bridge polls the broker for the live session's reply. |

The `remote-mcp` server is declared in the plugin manifest, so plugin installs load it automatically; the wizard can additionally register it user-scoped (`claude mcp add --scope user slack-bridge-remote -- node <path>/bin/claude-slack.mjs remote-mcp`) as a fallback for environments without plugin-declared MCP. Inbound delivery is push-or-poll: sessions launched with the `--dangerously-load-development-channels` allowlist naming slack-bridge receive rendered `<channel>` pushes; every other session — including cloud-model sessions — is instructed at handshake to poll `check_messages` on a 3-minute cron, so inbound Slack messages are never silently dropped.
