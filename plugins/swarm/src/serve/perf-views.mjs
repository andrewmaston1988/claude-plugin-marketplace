// Read-models over scores.mjs's own aggregate/dedupe output, computed
// server-side so the page never re-derives a count it could get wrong.
import { OUTCOMES } from "../aspects.mjs";
import { frontier } from "../scores.mjs";
import { band, resolveBands, THIN_REQUESTS, DEFAULT_COST_BANDS } from "../cost.mjs";

const blankOutcomes = () => Object.fromEntries(OUTCOMES.map((o) => [o, 0]));

// One cell per model×aspect, including pairs the model was never graded or
// scored on at all (n=0) — absence is evidence the grid must still draw.
// JSON-encoded tuple, not a joined string — a plain delimiter (space, ":") collides
// whenever an aspect or model name itself contains that delimiter.
const keyOf = (aspect, model) => JSON.stringify([aspect, model]);

export function coverage(report) {
  const aspects = report.aspects.map((a) => a.aspect);
  const models = [...new Set(report.aspects.flatMap((a) => a.cells.map((c) => c.model)))].sort();
  const byKey = new Map();
  for (const a of report.aspects) for (const c of a.cells) byKey.set(keyOf(a.aspect, c.model), c);
  const cells = [];
  for (const model of models) {
    for (const aspect of aspects) {
      const c = byKey.get(keyOf(aspect, model));
      cells.push({ model, aspect, n: c ? c.n : 0, provisional: c ? c.provisional : true });
    }
  }
  return { aspects, models, cells };
}

// Each deduped leaf (one row, however many aspects its grades cover) counts
// once — the aggregate report's per-aspect outcomes must never be summed
// across aspects, or an ungraded leaf multiplies by the aspect count.
export function reliability(liveRows) {
  const byModel = new Map();
  for (const r of liveRows) {
    if (!byModel.has(r.model)) byModel.set(r.model, { model: r.model, total: 0, byOutcome: blankOutcomes() });
    const m = byModel.get(r.model);
    m.total += 1;
    m.byOutcome[r.outcome] = (m.byOutcome[r.outcome] || 0) + 1;
  }
  return [...byModel.values()].sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
}

// Top k by weighted score per aspect — the same ranking `swarm perf` shows,
// just capped. A cell with no grade (outcomes only) has nothing to lead with.
export function leaders(report, k = 3) {
  return report.aspects.map((a) => ({
    aspect: a.aspect,
    top: a.cells.filter((c) => c.weighted != null)
      .slice().sort((x, y) => y.weighted - x.weighted || x.model.localeCompare(y.model))
      .slice(0, k)
      .map((c) => ({ model: c.model, weighted: c.weighted, n: c.n, provisional: c.provisional })),
  }));
}

// The cost read-model: the frontier's points (quality joined to cost) and the
// log cost spread (every costed model, cheapest first). `rows` are the raw
// score rows — the frontier needs overall()'s combined ranking, not the
// per-aspect report — and `costRows` are `multipliers(costPerModel(snaps))`.
// Cost itself is domain-blind (a request costs what it costs); only the
// quality half is filtered, so the join stays honest under a domain filter.
// A model with no multiplier is UNMEASURED, not free: it stays in `points`
// with `multiplier: null` so the page can draw it as a void, never a 0×.
export function costView(rows, costRows, { domain, bands = DEFAULT_COST_BANDS } = {}) {
  bands = resolveBands(bands, DEFAULT_COST_BANDS);
  const costs = costRows.map(({ model, mult }) => ({ model, mult }));
  const thinOf = new Map(costRows.map((r) => [r.model, r.measuredRequests < THIN_REQUESTS]));
  const points = frontier(rows, costs, { domain, bands })
    .filter((e) => e.wtd != null)
    .map(({ model, wtd, n, multiplier, band: b, onFrontier, dominatedBy }) => ({
      model, wtd, n, multiplier, band: b, onFrontier, dominatedBy, thin: thinOf.get(model) ?? false,
    }));
  const spread = costRows
    .map((r) => ({
      model: r.model, mult: r.mult, band: band(r.mult, bands),
      requests: r.requests, measuredRequests: r.measuredRequests,
      weeks: r.weeks, measuredWeeks: r.measuredWeeks,
      thin: r.measuredRequests < THIN_REQUESTS,
    }))
    .sort((a, z) => (a.mult ?? Infinity) - (z.mult ?? Infinity) || a.model.localeCompare(z.model));
  // The two verdicts worth a card, decided here so the page never re-derives
  // them. Neither is a quality-per-cost ratio — scores.mjs's frontier() rejects
  // that outright, and domination is the only comparison it makes. So `best` is
  // the highest-quality model nothing beats on BOTH axes, and `worst` the
  // dearest model something does. frontier() only ever sets onFrontier or
  // dominatedBy on a participant, so both carry a wtd and a multiplier by
  // construction; the filters below are still explicit, because a `best` picked
  // from all points would silently become "highest wtd overall".
  const best = points.filter((p) => p.onFrontier)
    .sort((a, z) => z.wtd - a.wtd || a.multiplier - z.multiplier || a.model.localeCompare(z.model))[0] ?? null;
  const worst = points.filter((p) => p.dominatedBy != null)
    .sort((a, z) => z.multiplier - a.multiplier || a.wtd - z.wtd || a.model.localeCompare(z.model))[0] ?? null;
  return { points, spread, bands, best, worst };
}
