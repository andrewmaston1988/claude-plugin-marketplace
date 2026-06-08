import { FALLBACK_VERBS, HEARTBEAT_COLORS, HEARTBEAT_INTERVAL_MS } from "./constants.mjs";
import { fetchHaikuVerb } from "./haiku-verb.mjs";

export function startHeartbeat({ web, channel, ts, cmdEcho, log, extensions, sessionId, config }) {
  let tick = 0;
  let stopped = false;
  const startTime = Date.now();
  const verbMode = config?.slack?.verbMode ?? "static";

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

    const lines = [`_${verb}${dots} ${cmdEcho} _(${elapsedStr})__`];
    if (augment) lines.push(augment);

    try {
      await web.chatUpdate({
        channel,
        ts,
        text: "",
        attachments: [{ color, text: lines.join("\n"), mrkdwn_in: ["text"] }],
      });
    } catch (e) {
      log?.warn("heartbeat update failed", { error: e.message });
    }
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
        });
      }
    },

    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
