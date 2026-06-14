---
name: /investigate
description: Quick investigation of an agent transcript
entry: shell
---

## Run investigation

```
${CLAUDE_PLUGIN_ROOT}/bin/claude-investigate.mjs locate {{ AGENT_ID }}
```

## Summary

```
${CLAUDE_PLUGIN_ROOT}/bin/claude-investigate.mjs summary {{ AGENT_ID }}
```

## Suggest next step

Based on the summary, suggest the next investigation subcommand:
- If errors > 0 → `/investigate errors {{ AGENT_ID }}`
- If retries > 0 → `/investigate retries {{ AGENT_ID }}`
- Otherwise → `/investigate pivots {{ AGENT_ID }}`
