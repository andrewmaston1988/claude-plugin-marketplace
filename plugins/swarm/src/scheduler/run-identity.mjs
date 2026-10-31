// Run identity (provider/runner stamping), the cooperative stop valve and its
// signal handlers, and the memory floor the spawn path is gated on.
import { appendRunLog } from "../results.mjs";

export function createRunIdentity(ctx) {
  const { cfg, providerRegistry, plan } = ctx;
  const providerCache = cfg.modelCache || cfg.models || [];
  const resolvedIdentity = (task) => providerRegistry.resolve(task, { cache: providerCache, config: cfg });
  // Hand-built unit plans predate durable provider identity. Keep their old
  // compact log shape, while every normalized manifest task (which has an
  // explicit provider) carries the provider and derived runner everywhere.
  const durableIdentity = (task) => {
    if (task?.provider === undefined) return {};
    const identity = resolvedIdentity(task);
    return { provider: identity.provider, runner: providerRegistry.get(identity.provider).runnerId };
  };

  // Cooperative stop: a control file, not a pid-kill — Windows TerminateProcess
  // runs no handler, so an external kill can never route through this, and a
  // pid the OS has since reused must never be mistaken for this run's engine.
  // Idempotent: the first caller (stop file or a signal) wins. Registered before
  // any await below so a signal during the health/quota preflight is caught too.
  const requestStop = (reason) => {
    if (ctx.stopRequested) return;
    ctx.stopRequested = true;
    ctx.stopReason = reason;
    appendRunLog(plan.resultsDir, { ts: new Date().toISOString(), event: "run-stop", reason });
    for (const child of ctx.children.values()) {
      try { child.kill(); } catch { /* already gone */ }
    }
    ctx.wake();
  };
  const onSignal = (sig) => () => requestStop(`signal:${sig}`);
  const sigintHandler = onSignal("SIGINT");
  const sigtermHandler = onSignal("SIGTERM");
  process.once("SIGINT", sigintHandler);
  process.once("SIGTERM", sigtermHandler);

  const memLow = (mb) => mb > 0 && ctx.io.freeMemMb() < mb;
  return { resolvedIdentity, durableIdentity, requestStop, sigintHandler, sigtermHandler, memLow };
}
