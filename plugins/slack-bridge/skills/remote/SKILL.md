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

It returns the channel name, e.g. `Slack remote ready: #rc-slack-bridge-remote-control — live session a1b2c3d4`. Report the channel name to the operator verbatim — tell them to DM it from a second device — then end your turn. There is nothing to arm or run.

If `slack_seize` is unavailable (the `slack-bridge-remote` MCP server isn't wired user-scoped), report that and stop — see "If the tool is missing" below. If it fails because no Claude session id was available, the claim has already been released; report the error.

## Receiving messages

The plugin's `Stop` hook listens for you. At the end of every turn it starts a background waiter, owned by Claude Code, not by you. When the operator messages the channel, the waiter exits and **wakes this session** with a hook reminder like:

```
Stop hook blocking error from command "...": Message from the operator on Slack, delivered through this hook. This is real user input, not a hook error. Reply normally; your text is mirrored to Slack.
SLACK: <text>
```

That reminder **is the operator's message**, not an error. Act on it as you would on any user message — tools included — and reply normally (see *Replying*). When the turn ends, the next `Stop` starts the next waiter. You never run, see or re-run a wait command.

Notes:

- A message sent while you are mid-turn arrives when the turn ends.
- After about 1 h 55 m with no message, the waiter wakes you once with `Slack waiter expired after <h>h. Nothing to do; end your turn and it restarts.` Do exactly that: end the turn.
- `WAIT FAILED: ...` means the broker refused the waiter (a 401 names `remote.controlToken`). Report it to the operator; the next turn retries.
- If you suspect a message went missing, `check_messages` still works — it takes anything queued for this session.
- `/clear` changes the session id and ends remote control: messages queue and nothing wakes you. Seize again to recover.

## Replying

Reply normally — just write your answer, as you would in any other turn. The plugin's `PostToolUse` and `Stop` hooks mirror the turn to the claimed channel: your narration posts as messages, and tool calls render as **one status line edited in place**, finalised when the turn stops. A claimed session asks in plain text rather than through `AskUserQuestion`: a `PreToolUse` hook mirrors the question and its options to the channel and then denies the tool, because the terminal dialog cannot be answered from Slack. Write the question with its options as normal text and end the turn.

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
