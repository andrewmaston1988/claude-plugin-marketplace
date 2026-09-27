import { seatOrder } from "./waves.mjs";

// Settle every ready inline step before any seat is spent, re-scanning until a pass
// settles nothing (an expansion can unlock more), then return the ready leaves in wave order.
export function settleInline(tasks, hooks) {
  let readyLeaves = [];
  let progressed = false;
  let settling;
  do {
    settling = false;
    readyLeaves = [];
    for (const t of tasks) {
      if (!hooks.pending(t) || !hooks.depsSatisfied(t)) continue;
      if (!hooks.passesWhen(t)) { settling = progressed = true; continue; }
      if (t.forEach) { hooks.expandForEach(t); settling = progressed = true; continue; }
      if (t.childPlan) { hooks.expandManifest(t); settling = progressed = true; continue; }
      if (t.aggregate) { hooks.runAggregate(t); settling = progressed = true; continue; }
      if (t.aggregateManifest) { hooks.runManifestAggregate(t); settling = progressed = true; continue; }
      if (t.compute) { hooks.runCompute(t); settling = progressed = true; continue; }
      if (t.integrate) { hooks.runIntegrate(t); settling = progressed = true; continue; }
      readyLeaves.push(t);
    }
  } while (settling);
  return { ready: seatOrder(readyLeaves, tasks), progressed };
}
