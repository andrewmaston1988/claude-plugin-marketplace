---
name: slack-remote
description: Seize a Slack channel for remote control of this live interactive session, so the operator can talk to you from a mobile device. Reply via slack_post. Use /slack-remote release to release the channel.
---

Remote control lets the operator step away from the terminal and keep talking to THIS live session from Slack on mobile — provider-agnostic (works on GLM, Kimi, any cloud model, not just the Anthropic API the built-in /rc needs).

## To seize a channel

Call the `slack_seize` MCP tool (no `channel` arg — the daemon creates one or seizes an existing DM):

```
slack_seize
```

It returns the channel name, e.g. `📱 Slack remote ready: #ln-a1b2 — live session a1b2c3d4`. Report that to the operator verbatim: tell them to DM that channel from a second device.

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