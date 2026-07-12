---
name: keepalive-status
description: >-
  Report cache-keepalive health: tick cadence, cache hits vs busts, and whether keepalive is enabled. Manual /keepalive-status.
disable-model-invocation: true
---

# keepalive-status

Audit the cache keepalive: realized tick cadence and recent cache hits/busts (from transcript `usage`), and whether keepalive is even enabled. A bust is irreversible, so this is an *audit*, not an alert.

## Workflow

1. Run (pass the session's `transcript_path` if you know it; omit otherwise — cadence still reports):
   ```bash
   node scripts/read-log.mjs "<transcript_path-or-omit>"
   ```
2. Relay the summary.
3. **If it reports `keepalive: DISABLED`**, offer to enable it — with the user's OK, set `"checkpoint": { "keepalive": true }` in `~/.claude/settings.json`.
4. If gaps exceeded the cache TTL or busts appear, the cadence ratios in `hooks/lib/cadence.mjs` may need tuning — each logged tick records the TTL it was paced against (`ttlSecs`, detected per-tick from the transcript's cache-bucket usage).
