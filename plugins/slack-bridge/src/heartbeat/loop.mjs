import { FALLBACK_VERBS, HEARTBEAT_COLORS, HEARTBEAT_INTERVAL_MS } from "./constants.mjs";
import { fetchHaikuVerb } from "./haiku-verb.mjs";

export function startHeartbeat({ web, channel, ts, cmdEcho, log, extensions, sessionId, config }) {
  let tick = 0;
  let stopped = false;
  let inflight = null;  // the current tick's chatUpdate promise, so stop() can join it
  const startTime = Date.now();
  const verbMode = config?.slack?.verbMode ?? "static";
  const verbModel = config?.slack?.verbModel ?? "claude-haiku-4-5";

  // Haiku verb state — updated asynchronously when tool changes
  let currentVerb = null;
  let lastTool = undefined;

  const timer = setInterval(async () => {
    if (stopped) return;
    tick++;
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    const elapsedStr = elapsedSec < 60
      ? `${elapsedSec}s`
      : `${Math.floor(elapsedSec / 60)}m${elapsedSec % 60}s`;
    const color = HEARTBEAT_COLORS[tick % HEARTBEAT_COLORS.length];
    const dots = ".".repeat((tick % 3) + 1);

    // Extension-provided verb (first-wins)
    let verb = null;
    let augment = null;

    if (extensions) {
      const tickCtx = {
        channel,
        sessionId,
        state: lastTool ? "running-tool" : "running",
        currentTool: lastTool,
        elapsedSec,
        config: config ?? {},
      };
      try {
        const verbViaExt = await extensions.runToolVerb({ tool: lastTool, channel, sessionId });
        if (verbViaExt) verb = verbViaExt;
      } catch { /* ignored */ }
      try {
        augment = await extensions.runHeartbeatAugment(tickCtx);
      } catch { /* ignored */ }
    }

    // Fall through to mode-based verb if extension didn't supply one
    if (!verb) {
      verb = currentVerb ?? FALLBACK_VERBS[tick % FALLBACK_VERBS.length];
    }

    // Two clean mrkdwn italic spans: `_verb…_` then the echoed command, then
    // `_(elapsed)_`. The old template `_${verb}${dots} ${cmdEcho} _(${elapsedStr})__`
    // had a stray `_(` and a trailing `__` that Slack couldn't pair, so the
    // underscores rendered literally (the `__Waiting__` symptom).
    const lines = [`_${verb}${dots}_ ${cmdEcho} _(${elapsedStr})_`];
    if (augment) lines.push(augment);

    // Re-check after the pre-update awaits: stop() may have been called while we
    // were awaiting runToolVerb/runHeartbeatAugment. Without this, a tick past its
    // top-of-loop guard can still fire chatUpdate(text:"") AFTER the final reply
    // has landed, clobbering the reply body back to the heartbeat footer. This is
    // the .py canon's `stop_event.wait(interval)` gate (slack_bridge.py:316) —
    // setting the event breaks the loop before the next chat_update fires.
    if (stopped) return;

    // Track the in-flight chatUpdate so stop() can join it (the .py canon's
    // hb_thread.join). The .catch swallows + logs so the promise never rejects —
    // a failed heartbeat update must not block the reply path that awaits it.
    const p = web.chatUpdate({
      channel,
      ts,
      text: "",
      attachments: [{ color, text: lines.join("\n"), mrkdwn_in: ["text"] }],
    }).catch(e => {
      log?.warn("heartbeat update failed", { error: e.message });
    });
    inflight = p;
    await p;
    if (inflight === p) inflight = null;
  }, HEARTBEAT_INTERVAL_MS);

  return {
    /** Notify the heartbeat that a tool is now active (from subprocess output parsing). */
    setTool(tool, input) {
      if (tool === lastTool) return;
      lastTool = tool;
      currentVerb = null; // clear stale verb while new one fetches
      if (verbMode === "haiku") {
        fetchHaikuVerb({
          tool,
          input,
          onVerb: v => { currentVerb = v; },
          log,
          model: verbModel,
        });
      }
    },

    stop() {
      stopped = true;
      clearInterval(timer);
      // .py canon (slack_bridge.py:685-688): "Stop heartbeat before writing final
      // response — prevents race where a final heartbeat tick overwrites the
      // response with the verb display." The .py does hb_thread.join(timeout=3)
      // — wait for the in-flight chatUpdate to land before the caller posts the
      // reply, so the heartbeat's text:"" update can't land AFTER and clobber it.
      // Cap at 3s so a hung Slack response never blocks the reply indefinitely
      // (matching join(timeout=3); inflight never rejects — .catch is internal).
      const join = inflight
        ? Promise.race([inflight, new Promise(r => setTimeout(r, 3000))])
        : Promise.resolve();
      return join;
    },
  };
}
