// Builders for the weekly usage snapshots the cost tests derive from. Shared by
// cost.test.mjs (the derivation) and cost-rate-cards.test.mjs (the provider tables),
// which both need to fabricate a history.
export const snap = (fetchedAt, models, pct) => ({ fetchedAt, weeklyPctUsed: pct, weeklyModels: models });
export const seg = (model, requests, meterSharePct) => ({ model, requests, meterSharePct });
