// The run's heartbeat: liveness file, stop-file watch, the memory valve, and the
// re-drive that hands memory-parked leaves back to the loop as pending.
import { existsSync } from "node:fs";
import { startHeartbeat } from "../heartbeat.mjs";
import { stopPath } from "../results.mjs";
import { pickNewestRunning } from "./run-task.mjs";

export function createHeartbeatTick(ctx) {
  const { cfg, plan } = ctx;

  // Heartbeat: touch the liveness file every tick — even while every leaf is
  // parked in backoff, since a reader must never mistake a resting engine for
  // a dead one — and repaint while anything runs so elapsed and live tokens
  // tick even between state changes. unref'd — never holds the process open.
  const heartbeatMs = Math.max(50, (cfg.heartbeatSecs ?? 15) * 1000);
  const beat = startHeartbeat(plan.resultsDir, ctx.started, heartbeatMs);
  const heartbeat = setInterval(() => {
    if (!ctx.stopRequested && existsSync(stopPath(plan.resultsDir))) ctx.requestStop("stop-file");
    // Valve (D4): a deliberate, targeted kill — cheaper than the whole run
    // dying to an OOM. Only when there is a second running leaf to fall back
    // to; children.get may already be gone if it settled between ticks.
    if (ctx.running.size > 1 && ctx.memLow(cfg.valveFreeMemMb)) {
      const newest = pickNewestRunning([...ctx.running.keys()], ctx.state, ctx.startedAt, ctx.children);
      if (newest !== undefined) {
        ctx.memoryStopped.add(newest);
        try { ctx.children.get(newest)?.kill(); } catch { /* already gone */ }
      }
    }
    // Re-drive (D3): once memory has recovered past the floor, OR nothing is
    // running at all (the spawn floor's own rule: never block the first leaf),
    // hand every parked leaf back as pending — the floor re-parks the rest.
    if (ctx.memoryParked.size > 0 && (ctx.running.size === 0 || !ctx.memLow(cfg.minFreeMemMb))) {
      for (const id of ctx.memoryParked) {
        ctx.state.set(id, "pending");
        ctx.activityMap.delete(id);
      }
      ctx.memoryParked.clear();
      if (heartbeat.unref) heartbeat.unref();
      ctx.wake();
    }
    if (ctx.running.size > 0) ctx.paint();
  }, heartbeatMs);
  if (heartbeat.unref) heartbeat.unref();

  return { beat, heartbeat };
}
