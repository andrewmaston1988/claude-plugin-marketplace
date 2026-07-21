---
name: slack-remote
description: Seize a Slack channel for remote control of this live interactive session, so the operator can talk to you from a mobile device. Reply via slack_post. Use /slack-remote release to release the channel.
---

Remote control lets the operator step away from the terminal and keep talking to THIS live session from Slack on mobile — provider-agnostic (works on GLM, Kimi, any cloud model, not just the Anthropic API the built-in /rc needs).

## To seize a channel

Call the `slack_seize` MCP tool. The daemon names the created channel `#rc-<slug>` where `<slug>` is chosen in this order:

1. **The session name the operator set in Claude Code** (the chat's custom title) — read automatically from the session JSONL. When the operator has named the chat, the channel "just appears" named after it. This always wins, so you never override a name the operator chose.
2. **A slug you derive from the current task context**, passed as the `name` arg — for the common case where the operator has *not* named the chat (operators rarely name chats). Derive it from something descriptive of what you're working on right now: the git branch (`autonomous/slack-bridge-remote-control` → `slack-bridge-remote-control`), the plan slug, or the feature/bug name. Slugify it yourself (lowercase, hyphens, no spaces). **Always do this** — it is your job, not the daemon's.
3. **The auto ai-title** — Claude Code's generated summary (often just derived from the first message, so maybe nonsensical). Read automatically as a last-resort fallback so the channel is never nameless.

The project dir basename is **never** used — a channel named after the project dir means something broke (you failed to derive a context slug). If even the ai-title is unreadable, the daemon falls back to a peer-id fragment (`#rc-a1b2`), which is the visible "something broke" signal.

So the normal call is to derive a context slug and pass it:

```
slack_seize  name="slack-bridge-remote-control"
```

If the operator has named the chat, your `name` is ignored and their custom title is used — so passing a context slug is always safe and never clobbers an operator-chosen name. If you skip the `name` arg and the chat isn't named, you get the (maybe nonsensical) ai-title — usable but rarely descriptive, so prefer to derive.

It returns the channel name, e.g. `📱 Slack remote ready: #rc-slack-bridge-remote-control — live session a1b2c3d4`. Report that to the operator verbatim: tell them to DM that channel from a second device.

If `slack_seize` is unavailable (the `slack-bridge-remote` MCP server isn't wired user-scoped), report that and stop — see "If the tool is missing" below.

## Receiving messages

Inbound Slack messages arrive as a `<channel source="slack-bridge">` block mid-turn. Reply IMMEDIATELY — pause what you're doing, answer, then resume. Treat it like a coworker tapping your shoulder.

## Replying

Reply with the `slack_post` tool:

```
slack_post  message="your reply to the operator"
```

(Equivalent: `send_message` with `to_id="slack-bridge"`.) Your reply replaces the "📱 routed to live session…" placeholder in Slack.

## Releasing

When the operator is done, release the channel so the next Slack message falls back to a fresh `claude -p` spawn:

```
slack_release
```

Or invoke `/slack-remote release`.

## If the tool is missing

`slack_seize` / `slack_post` only exist when the `slack-bridge-remote` MCP server is wired **user-scoped** (plugin-declared MCP does not render channel notifications as of 2026-07-16). If the tools aren't present, tell the operator to run the one-time registration and restart the session:

```
claude mcp add --scope user slack-bridge-remote -- node <install-path>/bin/claude-slack.mjs remote-mcp
```

and to set `remote.controlToken` in the bridge config (run `claude-slack doctor` to verify).