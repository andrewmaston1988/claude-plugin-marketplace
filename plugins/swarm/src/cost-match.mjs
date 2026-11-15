// Cost rows resolved onto a graded model — the identity+domain match the frontier
// reads. A model may hold several rows per provider and cost domain, so a lookup
// returns the first row that carries a multiplier, or the row itself when none
// does: a priced row is evidence, an unpriced one is a classification.

import { identityOf, identityKey } from "./contracts.mjs";
import { METER_POINTS_UNIT } from "./cost.mjs";

// Rows are keyed by provider+model; the domain is composed where the row
// leaves it out, exactly as the store's own writers do.
export function costIndex(costs) {
  const index = new Map();
  for (const cost of costs || []) {
    const identity = identityOf(cost);
    const key = identityKey(identity);
    index.set(key, [...(index.get(key) || []), {
      ...cost,
      ...identity,
      costDomain: cost.costDomain
        || `${identity.provider || "legacy"}:${cost.unit || METER_POINTS_UNIT}:${cost.classification || "legacy"}`,
    }]);
  }
  return index;
}

// Two domains for one model with none asked for is ambiguous, not a price.
export function costEntry(index, entry, costDomain) {
  const candidates = (index.get(identityKey(identityOf(entry))) || [])
    .filter((cost) => costDomain === undefined || cost.costDomain === costDomain);
  if (!candidates.length) return null;
  if (costDomain === undefined && new Set(candidates.map((cost) => cost.costDomain)).size > 1) return null;
  return candidates.find((cost) => cost.mult != null) || candidates[0];
}
