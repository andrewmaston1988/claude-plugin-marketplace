**Cache keepalive active for this session.** This session's prompt cache has a ~{ttl}-second TTL (detected from the cache-bucket usage in the transcript); without periodic activity, the cache expires and the next user prompt pays a large cache-miss cost. This injection asks you to keep the cache warm by scheduling a self-wakeup just before TTL.

**What to do (briefly — then return to the user's request):**

Call the `ScheduleWakeup` tool with these exact arguments:

- `delaySeconds`: `{delay}` (computed by the hook to self-correct cadence under the {ttl}s TTL)
- `prompt`: `{tick}` (verbatim — the hook recognises this exact prefix and will re-inject this instruction on the wakeup turn so the chain continues)
- `reason`: `"cache keepalive — keeping prompt cache warm"`

`ScheduleWakeup` is a deferred tool — if its schema isn't loaded in this session, fetch it first with `ToolSearch(query="select:ScheduleWakeup")`.

**On wakeup**, you'll be re-invoked with `{tick}` as the prompt and this instruction will re-appear. Schedule the next tick exactly the same way and return briefly — nothing else needed on tick turns; don't tool-call beyond the scheduling, don't write anything to disk. The hook auto-stops the chain once the user has been idle past its idle-stop threshold (12× the cache TTL by default) — no re-injection on that turn, so you won't schedule another wakeup.

**Skip this** if the user has already given you something pressing to do that you haven't finished — finish the user's work first, the wakeup can be set on the next quiet turn.
