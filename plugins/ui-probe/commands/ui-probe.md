---
name: /ui-probe
description: Capture a screen, run a UI probe scenario, or check the probe setup
entry: shell
---

## Run ui-probe

```
${CLAUDE_PLUGIN_ROOT}/bin/ui-probe.mjs $ARGUMENTS
```

## Suggest next step

Read the exit code and the digest, then:
- `validate` reported problems → fix the named field and run it again
- exit 3 `needs_review` → the scenario asserts nothing; add an assertion and re-run
- exit 64 → the scenario, config or arguments are invalid; the named field says which
- `doctor` failed → fix the named check before anything else
