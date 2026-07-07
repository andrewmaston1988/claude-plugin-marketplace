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
