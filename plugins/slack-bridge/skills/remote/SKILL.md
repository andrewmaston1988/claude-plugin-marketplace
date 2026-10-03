---
name: remote
description: Use when the operator wants remote control of this live session from Slack mobile — seizing a channel, arming the background waiter, receiving messages, replying, or releasing.
argument-hint: "[release]"
disable-model-invocation: true
---

Remote control lets the operator step away from the terminal and keep talking to THIS live session from Slack on mobile — provider-agnostic (works on GLM, Kimi, any cloud model, not just the Anthropic API the built-in /rc needs).

If `$ARGUMENTS` is `release`, skip straight to *Releasing*.

## To seize a channel

Call the `slack_seize` MCP tool. The daemon names the created channel `#rc-<slug>` where `<slug>` is chosen in this order:

1. **The session name the operator set in Claude Code** (the chat's custom title) — read from the `custom-title` record that `/rename` writes to the session JSONL, so when the operator has named the chat the channel appears named after it, and you never override a name the operator chose.
2. **A slug you derive from the current task context**, passed as the `name` arg — for the common case where the operator has *not* named the chat (operators rarely name chats). Derive it from something descriptive of what you're working on right now: the git branch (`autonomous/slack-bridge-remote-control` → `slack-bridge-remote-control`), the plan slug, or the feature/bug name. Slugify it yourself (lowercase, hyphens, no spaces). **Always do this** — it is your job, not the daemon's.
3. **The auto ai-title** — Claude Code's generated summary (often just derived from the first message, so maybe nonsensical). Read automatically as a last-resort fallback so the channel is never nameless.

The project dir basename is **never** used — a channel named after the project dir means something broke (you failed to derive a context slug). If even the ai-title is unreadable, the daemon falls back to a peer-id fragment (`#rc-a1b2`), which is the visible "something broke" signal.

On a default install (`createChannels: false` — no `channels:write` scopes) nothing is created: the daemon seizes the operator's **existing DM with the bot** instead, and `slack_seize` names that DM. Receiving, replying, and releasing work identically either way.

So the normal call is to derive a context slug and pass it:

```
slack_seize  name="slack-bridge-remote-control"
```

If the operator has named the chat and the harness recorded it, your `name` is ignored and their custom title is used — so passing a context slug is always safe and never clobbers an operator-chosen name. If you skip the `name` arg and the chat isn't named, you get the (maybe nonsensical) ai-title — usable but rarely descriptive, so prefer to derive.

It returns the channel name, e.g. `Slack remote ready: #rc-slack-bridge-remote-control — live session a1b2c3d4`, plus `wait_command` and `bash_timeout_ms`. Report the channel name to the operator verbatim — tell them to DM it from a second device — then **arm the waiter immediately** (next section).

If `slack_seize` is unavailable (the `slack-bridge-remote` MCP server isn't wired user-scoped), report that and stop — see "If the tool is missing" below.

## Arming the waiter — this is how you receive messages

There is no push and no polling cron. A background long-poll **is** the delivery path: run the command `slack_seize` returned, in the background, then go idle.

```
Bash  command=<wait_command>  run_in_background=true  timeout=<bash_timeout_ms>
```

The command holds the broker open in short windows (retrying connection blips with backoff) and exits the moment a Slack message for this session arrives.

## Receiving messages

1. Arm the waiter — `wait_command`, `run_in_background=true`, `timeout` = `bash_timeout_ms` — right after seizing, and again after every wake.
2. Go idle. When the operator messages the channel the waiter prints `SLACK: <text>` and exits; that background-task completion **wakes this session** as a new turn. No launch flag, no allowlist, no cron — it works on any model.
3. **Reply normally** — see *Replying*.
4. **Re-arm before the turn ends**: run the same `wait_command` in the background again.

Notes:

- The waiter caps itself short of the Bash limit: after ~1 h 55 m it prints `WAIT EXPIRED — re-arm: <command>` and exits 0, so an expiry is a wake with an instruction, not a silent death. Re-arm and carry on.
- If the waiter died and you want to check by hand, `check_messages` still works — it takes anything queued for this session.
- A `Stop` hook blocks a turn once when the channel is claimed and no waiter is armed, handing you the exact command in the block reason. Re-arm and finish the turn.

## Replying

Reply normally — just write your answer, as you would in any other turn. The plugin's `PostToolUse` and `Stop` hooks mirror the turn to the claimed channel: your narration posts as messages, and tool calls render as **one status line edited in place**, finalised when the turn stops.

Do **not** answer with a tool call. There is nothing to send by hand — the hooks already post your text, so a tool call per message wastes context and can post the same reply twice.

## Releasing

When the operator is done, release the channel so the next Slack message falls back to a fresh `claude -p` spawn:

```
slack_release
```

Or invoke `/remote release`.

## If the tool is missing

The tools ship on the `slack-bridge-remote` MCP server, declared in the plugin manifest — a normal plugin install loads it automatically. If the tools aren't present (no plugin installed, or an environment without plugin-declared MCP), tell the operator the fallback registration and to restart the session:

```
claude mcp add --scope user slack-bridge-remote -- node <install-path>/bin/claude-slack.mjs remote-mcp
```

and to set `remote.controlToken` in the bridge config (run `claude-slack doctor` to verify).
