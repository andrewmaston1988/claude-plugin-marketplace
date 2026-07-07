# slack-bridge

A two-way Slack ↔ Claude Code bridge. DM the bot or mention it in a channel and it invokes `claude -p` and posts the response.

Zero runtime dependencies. Requires Node 22+ and the `claude` CLI on PATH.

---

## Quick start

```
1. Generate the Slack app manifest
2. Create a Slack app using that manifest
3. Run: claude-slack setup
4. Run: claude-slack doctor
5. Run: claude-slack start
```

Full walkthrough below.

---

## Requirements

- Node.js 22 LTS or later
- `claude` CLI installed and authenticated — `claude --version` should print a version
- A Slack workspace where you can create apps

---

## Installation

### Option A — from the plugin marketplace

```bash
claude plugin marketplace add andrewmaston1988/claude-plugin-marketplace
claude plugin install slack-bridge@andrewmaston1988-claude-plugins
```

Then add `claude-slack` to your shell. Find the installed binary path:

```bash
ls ~/.claude/plugins/cache/andrewmaston1988-claude-plugins/slack-bridge/*/bin/claude-slack.mjs
```

**macOS / Linux** — add to `~/.bashrc` or `~/.zshrc`:

```bash
alias claude-slack='node /path/to/bin/claude-slack.mjs'
```

**Windows (PowerShell profile):**

```powershell
function claude-slack { & node "C:\path\to\bin\claude-slack.mjs" @args }
```

### Option B — from a local clone

```bash
git clone https://github.com/andrewmaston1988/claude-plugin-marketplace
cd claude-plugin-marketplace
```

Add an alias pointing at `plugins/slack-bridge/bin/claude-slack.mjs`, or run it as `node plugins/slack-bridge/bin/claude-slack.mjs` throughout.

---

## Setup

### Step 1 — Generate the Slack app manifest

```bash
claude-slack manifest --display-name "Claude Code"
```

This prints a YAML manifest. Copy it.

### Step 2 — Create the Slack app

Go to https://api.slack.com/apps → **Create New App** → **From a manifest** → paste the YAML.

Install the app to your workspace. You'll need two tokens:

| Token | Where to find it | Starts with |
|-------|-----------------|-------------|
| Bot token | *OAuth & Permissions* → *Bot User OAuth Token* | `xoxb-` |
| App-level token | *Basic Information* → *App-Level Tokens* → create one with `connections:write` scope | `xapp-` |

### Step 3 — Run the setup wizard

```bash
claude-slack setup
```

The wizard will ask for:
- Bot token
- App-level token
- Working directory for Claude (`claude -p` runs here)
- Optional: notify channel, session mode, autostart

It writes `config.json` to the OS config directory:

| OS | Config path |
|----|-------------|
| Windows | `%APPDATA%\claude-slack\config.json` |
| macOS | `~/Library/Application Support/claude-slack/config.json` |
| Linux | `~/.config/claude-slack/config.json` |

### Step 4 — Verify the setup

```bash
claude-slack doctor
```

All checks should show ✓. Fix any ✗ before proceeding.

### Step 5 — Start the bridge

**Foreground (for testing):**

```bash
claude-slack start
```

Watch for `Connected` in the log. DM the bot to test. Press Ctrl-C to stop.

**Background daemon:**

```bash
claude-slack start --daemon
claude-slack status    # → running (PID N)
```

**Persistent across reboots:**

```bash
claude-slack install-autostart
```

This registers the bridge as:
- a **Task Scheduler** entry on Windows
- a **launchd plist** on macOS
- a **systemd user service** on Linux

---

## Commands

```
claude-slack [start] [--daemon] [--config <path>]   Start the bridge (default command)
claude-slack stop                                    Stop a running daemon
claude-slack status                                  Show running status (PID if alive)
claude-slack notify [--title T] --message M          Post a one-shot notification
claude-slack manifest [--display-name X]             Print Slack app manifest YAML
claude-slack doctor [--json]                         Run diagnostic checks
claude-slack setup                                   Interactive setup wizard
claude-slack install-autostart                       Register OS-native autostart entry
claude-slack uninstall-autostart                     Remove autostart entry
claude-slack import-sessions <file.json>             Import sessions from another bridge
claude-slack --help                                  Show this help
```

**In Slack:**

| Command | Effect |
|---------|--------|
| `/new` or `/reset` | Clear session, start fresh |
| `/stop` | Kill in-flight Claude subprocess |
| `/restart` | Restart the bridge daemon |

---

## Configuration reference

Edit `config.json` (path shown in Step 3 above) to adjust any of these:

| Key | Default | Description |
|-----|---------|-------------|
| `tokens.bot` | *(required)* | Bot OAuth token (`xoxb-...`) |
| `tokens.app` | *(required)* | App-level token (`xapp-...`) for Socket Mode |
| `claude.cwd` | *(required)* | Working directory for `claude -p` invocations |
| `claude.addDir` | `null` | Extra `--add-dir` path passed to claude |
| `claude.model` | `null` | Agent model. `null` = Claude Code default. Claude names pass as `--model`; any other name (e.g. `minimax-m3:cloud`) routes via `proxy` — see [CONFIG.md](CONFIG.md) "Model routing" |
| `proxy.url` | `http://localhost:11434` | Anthropic-format endpoint for non-Claude models (ollama direct) |
| `proxy.authToken` | `"ollama"` | Pass-through placeholder — real auth is the ollama app's signin |
| `claude.timeout` | `180000` | Subprocess timeout in ms |
| `slack.onlyChannel` | `null` | If set, only respond in this channel ID |
| `slack.historyLimit` | `0` | Messages to fetch for context bootstrap (0 = disabled) |
| `slack.notifyChannel` | `null` | Channel for `claude-slack notify` when `--channel` is omitted |
| `slack.sessionKey` | `"channel-thread"` | `"channel"` or `"channel-thread"` |
| `slack.verbMode` | `"static"` | `"static"` (fallback verbs) or `"haiku"` (LLM-generated verbs) |
| `extensions` | `[]` | Paths to ESM extension modules |

---

## Troubleshooting

**Bot doesn't respond:** Run `claude-slack status` and check the log file path shown in `claude-slack doctor`.

**`claude: command not found`:** Make sure `claude` is on your PATH — run `claude --version` in the same terminal you use to start the bridge.

**Auth errors:** Confirm the bot token starts with `xoxb-` and the app token starts with `xapp-`. Both must belong to the same Slack app. Re-run `claude-slack setup` to reset.

**Bridge reconnects every ~10 s:** Update to the latest version — this was a bug in versions before the Socket Mode ping/pong fix.

**`claude-slack: command not found`:** The binary path isn't on your PATH. Follow the alias instructions in Installation above, or re-run `claude-slack setup` — the wizard adds a PATH step.

**Windows: process exits with code 127:** Update to the latest version — this was a Windows-specific exit bug fixed after Plan 2.
