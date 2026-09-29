// The live face of a run: roster painting, per-state recording, the stream hooks
// that land a leaf's ticks, and the retry/memory park that holds a leaf back.
import { basename } from "node:path";
import { appendRunLog, renderRoster } from "../results.mjs";
import { tokenTotal } from "../stream.mjs";

export function createLivePaint(ctx) {
  const { cfg, io, plan } = ctx;

  let lastPaintMs = 0;
  const paint = (force = true) => {
    if (!io.snapshot) return;
    if (!force && io.now() - lastPaintMs < 1000) return; // token ticks repaint at most 1/s
    lastPaintMs = io.now();
    io.snapshot(renderRoster({
      title: basename(plan.resultsDir),
      tasks: ctx.tasks.map((t) => ({
        id: t.id, model: t.model, state: ctx.state.get(t.id), ...ctx.durableIdentity(t),
        durationMs: ctx.durations.get(t.id),
        startedMs: ctx.startedAt.get(t.id),
        tokens: ctx.tokensMap.get(t.id),
        activity: ctx.activityMap.get(t.id),
        // a leaf that never emitted an event counts as quiet since launch
        lastEventMs: ctx.lastEventAt.get(t.id) ?? ctx.startedAt.get(t.id),
      })),
      now: io.now(),
      startedMs: ctx.runStartMs,
      quietWarnMs: (cfg.quietWarnSecs ?? 60) * 1000,
      maxLines: io.maxLines ?? null,
    }));
  };

  const record = (task, st, durationMs, tokens, note) => {
    ctx.state.set(task.id, st);
    if (st === "running") ctx.startedAt.set(task.id, io.now());
    if (durationMs != null) ctx.durations.set(task.id, durationMs);
    if (tokens && tokenTotal(tokens) > 0) ctx.tokensMap.set(task.id, tokens);
    appendRunLog(plan.resultsDir, {
      ts: new Date().toISOString(), id: task.id, state: st,
      ...ctx.durableIdentity(task),
      ...(durationMs != null && { durationMs }),
      ...(ctx.tokensMap.has(task.id) && st !== "running" && { tokens: ctx.tokensMap.get(task.id) }),
      ...(note && { note }),
    });
    paint();
  };

  // Live ticks from a leaf's stream: token totals and tool-call activity both
  // land in run.log (feeding the status view + statusline glyph) plus a
  // throttled roster repaint. Activity log lines are rate-limited per leaf —
  // a busy leaf calls tools far faster than a watcher needs.
  const streamHooks = (task) => ({
    onChild: (child) => ctx.children.set(task.id, child),
    // Durable the moment the stream names it: an engine that dies before this
    // leaf settles writes no result, and without this line resume starts cold.
    onSession: (sessionId) => {
      appendRunLog(plan.resultsDir, { ts: new Date().toISOString(), id: task.id, event: "session", sessionId, ...ctx.durableIdentity(task) });
    },
    onTokens: (totals) => {
      ctx.tokensMap.set(task.id, totals);
      ctx.lastEventAt.set(task.id, io.now());
      appendRunLog(plan.resultsDir, { ts: new Date().toISOString(), id: task.id, event: "tokens", tokens: totals, ...ctx.durableIdentity(task) });
      paint(false);
    },
    onActivity: (desc) => {
      ctx.activityMap.set(task.id, desc);
      ctx.lastEventAt.set(task.id, io.now());
      if (io.now() - (ctx.lastActivityLogAt.get(task.id) ?? 0) >= 2000) {
        ctx.lastActivityLogAt.set(task.id, io.now());
        appendRunLog(plan.resultsDir, { ts: new Date().toISOString(), id: task.id, event: "activity", activity: desc, ...ctx.durableIdentity(task) });
      }
      paint(false);
    },
  });

  // Park a leaf for delayMs, then hand it back to the scheduler loop as
  // pending. The concurrency slot frees during the wait (the launch promise
  // resolves); depsDoomed treats 'retrying' as alive so dependents hold.
  const scheduleRetry = (task, delayMs, note) => {
    ctx.retryWaiting++;
    ctx.state.set(task.id, "retrying");
    ctx.activityMap.set(task.id, note);
    appendRunLog(plan.resultsDir, { ts: new Date().toISOString(), id: task.id, state: "retrying" });
    paint();
    // Deliberately ref'd (unlike the heartbeat): a parked retry is pending
    // work, and with nothing else running an unref'd timer lets the event
    // loop drain — node exits 13 with the run's top-level await unsettled.
    setTimeout(() => {
      ctx.retryWaiting--;
      ctx.state.set(task.id, "pending");
      ctx.activityMap.delete(task.id);
      ctx.wake();
    }, delayMs);
  };

  // Park a leaf for low memory: no timer. The heartbeat (ref'd for as long as
  // anything is parked — see below) is what re-drives it once io.freeMemMb()
  // clears minFreeMemMb again; a parked leaf never spawned, so nothing here
  // touches attempts.
  const parkForMemory = (task) => {
    ctx.memoryParked.add(task.id);
    ctx.memoryParkCount++;
    ctx.state.set(task.id, "retrying");
    ctx.activityMap.set(task.id, `⏸ low memory — ${(io.freeMemMb() / 1024).toFixed(1)} GB free`);
    appendRunLog(plan.resultsDir, { ts: new Date().toISOString(), id: task.id, state: "retrying", note: "memory-park" });
    paint();
    if (ctx.heartbeat.ref) ctx.heartbeat.ref();
  };

  return { paint, record, streamHooks, scheduleRetry, parkForMemory };
}
