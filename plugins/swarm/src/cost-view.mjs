// The cost read-model behind the Cost screen and `swarm perf`'s needs-grades
// block, and the supersession marking both read. Pure over injected rows, and it
// imports nothing from `serve/` — the CLI needs the same view the dashboard serves.
import { overall, dominates } from "./scores.mjs";
import { identityOf } from "./contracts.mjs";
import { supersessionReading, supersessionKey, successorPitch, isReady } from "./supersession.mjs";
import { band, coins, resolveBands, resolveValueMargin, THIN_REQUESTS, DEFAULT_COST_BANDS } from "./cost.mjs";

// The supersession reading, written onto the rows so a screen can filter or mark them.
function markSuperseded(rows, { providerKey = () => "unqualified", ...options } = {}) {
  const { superseded, pending } = supersessionReading(rows, { providerKey, ...options });
  for (const row of rows) {
    const key = supersessionKey(providerKey(row), row.model);
    const by = superseded.get(key);
    const next = pending.get(key);
    // A card's base model IS its section's unit: the screen labels every multiplier
    // against it, so a newer sibling must never hide it — but it is still retired
    // from the verdicts, or the unit wins the card from its own successor.
    if (row.baseModel !== undefined && row.model === row.baseModel) {
      if (by) row.retiredBy = by;
      continue;
    }
    if (by) row.supersededBy = by;
    else if (next) row.pendingSuccessor = next;
  }
  return rows;
}

// The verdict words an elder wears, read off the section that decided them so no
// screen re-decides best value on its own.
export function verdictsIn(section, model) {
  const at = section?.points.find((p) => p.model === model);
  if (!at) return [];
  if (section.best === at) return ["best value"];
  return at.onFrontier ? ["frontier"] : [];
}

// Readiness from a set of graded cells: the n a model has actually earned, keyed
// by provider + model like the supersession reading itself. Never `provisional` —
// an outcome-only cell reads n=0 and provisional=false, which would pass.
export function readyFrom(cells, providerOf) {
  const graded = new Map(cells.map((cell) => [supersessionKey(providerOf(cell), cell.model), cell.n || 0]));
  return (provider, model) => isReady(graded.get(supersessionKey(provider, model)));
}

// One cell per model×aspect, including pairs the model was never graded or
// scored on at all (n=0) — absence is evidence the grid must still draw.
// JSON-encoded tuple, not a joined string — a plain delimiter (space, ":") collides
// whenever an aspect or model name itself contains that delimiter.
export function providersOf(value) {
  const providers = Array.isArray(value?.providers) ? [...value.providers] : [];
  const identity = identityOf(value);
  if (identity.provider) providers.push(identity.provider);
  return [...new Set(providers.filter((p) => typeof p === "string" && p))].sort();
}

export const displayOf = (identity) => identity.explicit && identity.provider
  ? `${identity.provider}/${identity.model}`
  : identity.model;
export const compareIdentity = (a, b) => displayOf(identityOf(a)).localeCompare(displayOf(identityOf(b)));

// The cost read-model: quality is collapsed by model, while every cost row
// remains attached to its provider and compatible cost domain. A model with
// no multiplier is UNMEASURED, not free: it stays in `points` with
// `multiplier: null` so the page can draw it as a void, never a 0×.
//
// It reads no denylist: Cost is a price reference, not a dispatch roster, so a
// family's newest member supersedes its elders whether or not it is dispatchable.
export function costView(rows, costRows, { domain, costDomain, bands = DEFAULT_COST_BANDS, valueMargin, cloudSuffix = ":cloud" } = {}) {
  bands = resolveBands(bands, DEFAULT_COST_BANDS);
  const margin = resolveValueMargin(valueMargin);
  const costs = costRows.filter((row) => costDomain === undefined || row.costDomain === costDomain);
  const providerKey = (value) => identityOf(value).provider || "unqualified";
  const costFor = (model, provider) => {
    const matches = costs.filter((r) => r.model === model && providerKey(r) === provider);
    if (!matches.length) return null;
    const domains = new Set(matches.map((r) => r.costDomain || "legacy"));
    if (costDomain === undefined && domains.size > 1) return null;
    return matches.find((r) => r.mult != null) || matches[0];
  };
  // One coin range per provider and cost domain — the axes that share a unit.
  const rangeKey = (r) => `${providerKey(r)}|${r.costDomain || "legacy"}`;
  const ranges = new Map();
  for (const r of costs) {
    if (r.mult == null || !Number.isFinite(r.mult) || r.mult <= 0) continue;
    const k = rangeKey(r), g = ranges.get(k);
    ranges.set(k, g ? { lo: Math.min(g.lo, r.mult), hi: Math.max(g.hi, r.mult) } : { lo: r.mult, hi: r.mult });
  }
  const isMeter = (r) => !r?.unit || r.unit === "meter-points" || r.unit === "quota-weight" || r.unit === "meter-points/request";
  const quality = overall(rows, { domain, combineProviders: true }).cells.filter((c) => c.combined != null);
  const points = quality.flatMap((cell) => {
    const providers = new Set(providersOf(cell));
    for (const cost of costs) if (cost.model === cell.model) providers.add(providerKey(cost));
    if (!providers.size) providers.add("unqualified");
    return [...providers].sort().map((provider) => {
      const evidence = costFor(cell.model, provider);
      const identity = provider === "unqualified"
        ? { model: cell.model }
        : { provider, model: cell.model };
      return {
        ...(provider !== "unqualified" ? { provider } : {}),
        model: cell.model,
        label: displayOf(identityOf(identity)),
        wtd: cell.combined,
        n: cell.n,
        multiplier: evidence?.mult ?? null,
        band: evidence?.mult == null ? null : band(evidence.mult, bands),
        coins: evidence ? coins(evidence.mult, ranges.get(rangeKey(evidence))) : null,
        onFrontier: false,
        dominatedBy: null,
        thin: Boolean(evidence && isMeter(evidence) && evidence.measuredRequests < THIN_REQUESTS),
        ...(evidence?.costDomain ? { costDomain: evidence.costDomain } : {}),
        ...(evidence?.unit !== undefined ? { unit: evidence.unit } : {}),
        ...(evidence?.source !== undefined ? { source: evidence.source } : {}),
        ...(evidence?.classification !== undefined ? { classification: evidence.classification } : {}),
        ...(evidence?.asOf !== undefined ? { asOf: evidence.asOf } : {}),
        ...(evidence?.value !== undefined ? { value: evidence.value } : {}),
        ...(evidence?.baseModel !== undefined ? { baseModel: evidence.baseModel } : {}),
      };
    });
  });
  const spread = costs
    .map((r) => ({
      ...(identityOf(r).provider ? { provider: identityOf(r).provider } : {}),
      model: r.model, label: displayOf(identityOf(r)), mult: r.mult, band: band(r.mult, bands), coins: coins(r.mult, ranges.get(rangeKey(r))),
      requests: r.requests, measuredRequests: r.measuredRequests,
      weeks: r.weeks, measuredWeeks: r.measuredWeeks,
      thin: isMeter(r) && r.measuredRequests < THIN_REQUESTS,
      ...(r.costDomain !== undefined ? { costDomain: r.costDomain } : {}),
      ...(r.unit !== undefined ? { unit: r.unit } : {}),
      ...(r.source !== undefined ? { source: r.source } : {}),
      ...(r.classification !== undefined ? { classification: r.classification } : {}),
      ...(r.asOf !== undefined ? { asOf: r.asOf } : {}),
      ...(r.value !== undefined ? { value: r.value } : {}),
      ...(r.baseModel !== undefined ? { baseModel: r.baseModel } : {}),
    }))
    .sort((a, z) => (a.mult ?? Infinity) - (z.mult ?? Infinity) || compareIdentity(a, z));
  // Readiness is the successor's own graded n, per identity: a model two
  // providers share has one reading each, and the merged cost cell has neither.
  const ready = readyFrom(overall(rows, { domain }).cells, (cell) => identityOf(cell).provider || "unqualified");
  markSuperseded([...points, ...spread], { providerKey, cloudSuffix, ready });

  // Verdicts are intentionally local. A single global best/worst would imply
  // that (say) an Ollama meter point and a Codex plan-rate point share a cost
  // axis, which they do not. When a caller asks for one provider/domain the
  // legacy top-level cards remain useful; mixed views expose provider sections
  // and leave the global cards null.
  const verdicts = (sectionPoints, sectionSpread) => {
    const domains = new Set(sectionSpread.map((row) => row.costDomain || "legacy"));
    if (domains.size > 1) return { best: null, worst: null };
    // Under PROVISIONAL_N grades a score is a coin toss: it neither sets the bar nor wins.
    const eligible = sectionPoints.filter((p) => !p.supersededBy && !p.retiredBy && p.onFrontier
      && p.multiplier != null && !p.thin && isReady(p.n));
    // A pending elder is on its way out: it neither sets the margin's top nor
    // takes the card, unless it is the section's only candidate.
    const settled = eligible.filter((p) => !p.pendingSuccessor);
    const candidates = settled.length ? settled : eligible;
    const topWtd = candidates.reduce((m, p) => (p.wtd > m ? p.wtd : m), -Infinity);
    const best = candidates.filter((p) => p.wtd >= topWtd - margin)
      .sort((a, z) => a.multiplier - z.multiplier || z.wtd - a.wtd || compareIdentity(a, z))[0] ?? null;
    // Nor is it this provider's worst buy — it does not collect that verdict
    // on its way out.
    const worst = sectionPoints.filter((p) => !p.supersededBy && !p.retiredBy && !p.pendingSuccessor && p.dominatedBy != null && isReady(p.n))
      .sort((a, z) => z.multiplier - a.multiplier || a.wtd - z.wtd || compareIdentity(a, z))[0] ?? null;
    return { best, worst };
  };
  const providers = [...new Set([...points, ...costs].map(providerKey))].sort();
  for (const sectionProvider of providers) {
    const sectionPoints = points.filter((point) => providerKey(point) === sectionProvider);
    // A row barred from the verdicts cannot decide them by dominating the pick either.
    const participants = sectionPoints.filter((point) => !point.supersededBy && !point.retiredBy && isReady(point.n)
      && point.wtd != null && point.multiplier != null);
    const comparable = sectionPoints.filter((point) => point.wtd != null && point.multiplier != null);
    for (const point of comparable) {
      const dominator = participants.find((other) => other !== point
        && other.costDomain === point.costDomain
        && dominates(other, point));
      if (dominator) point.dominatedBy = displayOf(identityOf(dominator));
      else point.onFrontier = true;
    }
  }
  const sections = providers.map((key) => {
    const sectionPoints = points.filter((point) => providerKey(point) === key);
    const sectionSpread = spread.filter((row) => providerKey(row) === key);
    const { best, worst } = verdicts(sectionPoints, sectionSpread);
    return {
      provider: key === "unqualified" ? null : key,
      points: sectionPoints,
      spread: sectionSpread,
      costDomains: [...new Set(sectionSpread.map((row) => row.costDomain || "legacy"))].sort(),
      best,
      worst,
    };
  });
  // A successor below the handover wears its elder's own record, read off the
  // verdicts just decided so the chip cannot disagree with the hero.
  const rankOf = new Map(quality.map((cell, i) => [cell.model, i + 1]));
  for (const section of sections) {
    const rowsOf = [...section.points, ...section.spread];
    for (const elder of new Set(rowsOf.filter((r) => r.pendingSuccessor).map((r) => r.model))) {
      const pitch = successorPitch({ elder, rank: rankOf.get(elder), verdicts: verdictsIn(section, elder) });
      const successor = rowsOf.find((r) => r.model === elder).pendingSuccessor;
      for (const r of rowsOf) if (r.model === successor) r.pitch = pitch;
    }
  }
  const global = providers.length === 1 ? verdicts(points, spread) : { best: null, worst: null };
  return {
    points, spread, sections, bands, valueMargin: margin,
    ...(costDomain !== undefined && { costDomain }),
    best: global.best,
    worst: global.worst,
  };
}

