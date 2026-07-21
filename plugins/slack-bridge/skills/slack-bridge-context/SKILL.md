---
name: slack-bridge-context
description: Use when running a Claude Code session under the Slack bridge (CLAUDE_VIA_SLACK=1). Enforces commands-in-standalone-code-blocks and no-colon-before-tool-calls.
---

`CLAUDE_VIA_SLACK=1` is set — the user is on mobile Slack. Apply these rules for the duration of the session:

1. **Commands in standalone code blocks.** Every runnable command must be in a fenced code block on its own, with no other text in the same message. The user is on mobile — long-pressing a Slack message is the only way to copy it. A command mixed with explanation cannot be cleanly copied.

2. **Run commands yourself.** Use tools to execute commands rather than presenting them to the user. Only send a command to the user when it requires elevation (admin/SYSTEM privileges) or cannot be run from the sandbox.

3. **No colon before tool calls.** Do not write "Let me read the file:" followed by a tool call — the tool call may not be visible in Slack output. Write "Reading the file." with a period, or just do it.
