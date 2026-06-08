## Before you do anything else — declare your progress

**Run this command first, before reading the plan or context below.** The dashboard panel needs your steps registered so it can show what you're doing.

```
{{PIPELINE_BIN}} progress-create {{PROJECT}} "$CORRELATION_ID" --steps "step1|step2|step3|..."
```

Pick 3–8 short labels that match the Instructions section below. Pipe-separated. Don't skip this step — the dashboard will show 0/0 (effectively invisible) until you do.

`$CORRELATION_ID` is the orchestrator's per-spawn id (set in your shell env) — keying off it guarantees each spawn gets its own progress trail, not a shared one from a previous attempt on the same plan today.

**As you work through each step**, mark it in_progress when starting, completed when done:

```
{{PIPELINE_BIN}} progress-mark   {{PROJECT}} "$CORRELATION_ID" 0 in_progress
# ...do step 0 work...
{{PIPELINE_BIN}} progress-mark   {{PROJECT}} "$CORRELATION_ID" 0 completed
{{PIPELINE_BIN}} progress-mark   {{PROJECT}} "$CORRELATION_ID" 1 in_progress
```
