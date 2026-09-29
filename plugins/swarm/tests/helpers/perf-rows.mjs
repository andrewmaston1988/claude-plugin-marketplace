// Minimal valid row — mirrors scores.test.mjs's baseline shape so aggregate()
// and dedupe() see exactly what the real store would hand them.
export function row(over = {}) {
  return {
    resultsDir: "C:/runs/x-1",
    leaf: "leaf",
    model: "m",
    domain: "godot",
    grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8 },
    outcome: "completed",
    note: "",
    assessedBy: { session: "s" },
    ...over,
  };
}
export const graded = (over) => row({ note: "x", ...over });

// Multiplier rows as `multipliers(costPerModel(snaps))` emits them. `m-thin`
// is measured but under the 200-request confidence bar (so it is NOT eligible
// to be the floor); `m-unpriced` has no history at all (a Claude tier reads
// the same). m-cheap carries six leaves so its weighted score survives
// shrinkage and can dominate m-thin on both axes.
export const costRow = (model, mult, over = {}) => ({
  model, mult,
  ptsPerReq: mult == null ? null : mult * 0.025,
  requests: 300, measuredRequests: 300, weeks: 1, measuredWeeks: 1,
  ...over,
});
