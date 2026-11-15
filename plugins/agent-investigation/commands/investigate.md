---
name: /investigate
description: Quick investigation of an agent transcript
entry: shell
---

## Run investigation

```
${CLAUDE_PLUGIN_ROOT}/bin/claude-investigate.mjs locate $ARGUMENTS
```

## Summary

```
${CLAUDE_PLUGIN_ROOT}/bin/claude-investigate.mjs summary $ARGUMENTS
```

## Suggest next step

Based on the summary, suggest the next investigation subcommand:
- If errors > 0 → `/investigate errors <agent-id>`
- If retries > 0 → `/investigate retries <agent-id>`
- Otherwise → `/investigate pivots <agent-id>`
