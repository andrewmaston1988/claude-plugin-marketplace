---
name: slack-remote
description: Use when the operator wants remote control of this live session from Slack mobile — seizing a channel, receiving messages, replying, or releasing.
argument-hint: "[release]"
disable-model-invocation: true
---

Remote control lets the operator step away from the terminal and keep talking to THIS live session from Slack on mobile — provider-agnostic (works on GLM, Kimi, any cloud model, not just the Anthropic API the built-in /rc needs).

If `$ARGUMENTS` is `release`, skip straight to *Releasing*.

## To seize a channel

Call the `slack_seize` MCP tool. The daemon names the created channel `#rc-<slug>` where `<slug>` is chosen in this order:

1. **The session name the operator set in Claude Code** (the chat's custom title) — read from the session JSONL where the harness records one (best-effort: not observed on every harness), so when the operator has named the chat the channel appears named after it, and you never override a name the operator chose.
2. **A slug you derive from the current task context**, passed as the `name` arg — for the common case where the operator has *not* named the chat (operators rarely name chats). Derive it from something descriptive of what you're working on right now: the git branch (`autonomous/slack-bridge-remote-control` → `slack-bridge-remote-control`), the plan slug, or the feature/bug name. Slugify it yourself (lowercase, hyphens, no spaces). **Always do this** — it is your job, not the daemon's.
3. **The auto ai-title** — Claude Code's generated summary (often just derived from the first message, so maybe nonsensical). Read automatically as a last-resort fallback so the channel is never nameless.

The project dir basename is **never** used — a channel named after the project dir means something broke (you failed to derive a context slug). If even the ai-title is unreadable, the daemon falls back to a peer-id fragment (`#rc-a1b2`), which is the visible "something broke" signal.

On a default install (`createChannels: false` — no `channels:write` scopes) nothing is created: the daemon seizes the operator's **existing DM with the bot** instead, and `slack_seize` names that DM. Receiving, replying, and releasing work identically either way.

So the normal call is to derive a context slug and pass it:

```
slack_seize  name="slack-bridge-remote-control"
```

If the operator has named the chat and the harness recorded it, your `name` is ignored and their custom title is used — so passing a context slug is always safe and never clobbers an operator-chosen name. If you skip the `name` arg and the chat isn't named, you get the (maybe nonsensical) ai-title — usable but rarely descriptive, so prefer to derive.

It returns the channel name, e.g. `📱 Slack remote ready: #rc-slack-bridge-remote-control — live session a1b2c3d4`. Report that to the operator verbatim: tell them to DM that channel from a second device.

If `slack_seize` is unavailable (the `slack-bridge-remote` MCP server isn't wired user-scoped), report that and stop — see "If the tool is missing" below.

## Receiving messages

Two delivery paths, depending on how this session was launched:

- **Push** (launched with `--dangerously-load-development-channels plugin:slack-bridge`): inbound Slack messages arrive as a `<channel source="slack-bridge">` block mid-turn. Reply IMMEDIATELY — pause what you're doing, answer, then resume. Treat it like a coworker tapping your shoulder.
- **Poll** (no such flag — every cloud-model session, and most others): the block never renders. Set up the recurring poll the MCP server's `initialize` instructions prescribe — follow them verbatim; they carry the exact `CronCreate` call, the schema-load step, and the job's 7-day expiry.

  Between ticks, call `check_messages` directly whenever you're waiting on the operator's reply.

The MCP server's `initialize` instructions state which path you are on — follow them.

## Replying

Reply with the `slack_post` tool:

```
slack_post  message="your reply to the operator"
```

(Equivalent: `send_message` with `to_id="slack-bridge"`.) Answer inside the routing window and your reply replaces the "📱 routed to live session…" placeholder in Slack. Land it after the window — the session was slow, or no message was routed — and the daemon still posts it to the channel as its own message rather than dropping it.

## Releasing

When the operator is done, release the channel so the next Slack message falls back to a fresh `claude -p` spawn:

```
slack_release
```

Or invoke `/slack-remote release`.

## If the tool is missing

The tools ship on the `slack-bridge-remote` MCP server, declared in the plugin manifest — a normal plugin install loads it automatically. If the tools aren't present (no plugin installed, or an environment without plugin-declared MCP), tell the operator the fallback registration and to restart the session:

```
claude mcp add --scope user slack-bridge-remote -- node <install-path>/bin/claude-slack.mjs remote-mcp
```

and to set `remote.controlToken` in the bridge config (run `claude-slack doctor` to verify).
