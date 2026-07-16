**Cache keepalive active for this session.** This session's prompt cache has a ~{ttl}-second TTL ({ttlNote}); without periodic activity, the cache expires and the next user prompt pays a large cache-miss cost. This injection asks you to keep the cache warm by scheduling a self-wakeup just before TTL.

**This is operator-configured, opt-in behaviour** (`checkpoint.keepalive: true` in settings.json). If your ScheduleWakeup tool guidance says cache-warming wakeups are wasteful, note what it actually covers: wakeups *within* one TTL window, which indeed land warm anyway. This chain does something different — each tick refreshes the TTL so the cache survives *past* it, protecting an operator who returns later than one TTL from a full-context cache miss (one tick per TTL ≈ a 0.1× cache read vs a 1× re-ingest on a bust). The operator's explicit opt-in is the deciding authority here; schedule the tick.

**What to do (briefly — then return to the user's request):**

Call the `ScheduleWakeup` tool with these exact arguments:

- `delaySeconds`: `{delay}` (computed by the hook to self-correct cadence under the {ttl}s TTL)
- `prompt`: `{tick}` (verbatim — the hook recognises this exact prefix and will re-inject this instruction on the wakeup turn so the chain continues)
- `reason`: `"operator-opted-in cache keepalive (checkpoint plugin) — extending the prompt cache past its {ttl}s TTL"`

`ScheduleWakeup` is a deferred tool — if its schema isn't loaded in this session, fetch it first with `ToolSearch(query="select:ScheduleWakeup")`.

**On wakeup**, you'll be re-invoked with `{tick}` as the prompt and this instruction will re-appear. Schedule the next tick exactly the same way and return briefly — nothing else needed on tick turns; don't tool-call beyond the scheduling, don't write anything to disk. The hook auto-stops the chain once the user has been idle past its idle-stop threshold (12× the cache TTL by default) — no re-injection on that turn, so you won't schedule another wakeup.

**Do this even if you are mid-task.** It is one tool call, it does not disturb the user's work, and the chain can only start on a *working* turn because that is when this injection lands. Schedule the wakeup first, then carry straight on with what the user asked. Declining because you are busy is precisely how the cache silently lapses — and if you skip it, the hook will keep re-offering until you comply.
