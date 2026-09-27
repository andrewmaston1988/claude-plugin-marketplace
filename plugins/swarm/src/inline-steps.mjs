import { seatOrder } from "./waves.mjs";

// Settle every ready inline step the scheduler can take without spending a
// seat — a when-skip, a forEach or manifest expansion, an aggregation, a
// compute, an integrate — then return what is left, in wave order.
//
// The scan re-drives until a pass settles nothing: an expansion can unlock a
// later task in the same pass, and the leaves it seats must be weighed against
// the ones already ready rather than jumped ahead of them.
//
// hooks carries the scheduler's own closures: pending, depsSatisfied,
// passesWhen, expandForEach, expandManifest, runAggregate, runManifestAggregate,
// runCompute, runIntegrate.
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
