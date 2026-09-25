// Read-models over scores.mjs's own aggregate/dedupe output, computed
// server-side so the page never re-derives a count it could get wrong.
import { OUTCOMES } from "../aspects.mjs";
import { overall } from "../scores.mjs";
import { identityOf } from "../contracts.mjs";
import { collapseFamilies, visibleModels } from "../discovery.mjs";
import { band, coins, resolveBands, resolveValueMargin, THIN_REQUESTS, DEFAULT_COST_BANDS } from "../cost.mjs";

const blankOutcomes = () => Object.fromEntries(OUTCOMES.map((o) => [o, 0]));

// One cell per model×aspect, including pairs the model was never graded or
// scored on at all (n=0) — absence is evidence the grid must still draw.
// JSON-encoded tuple, not a joined string — a plain delimiter (space, ":") collides
// whenever an aspect or model name itself contains that delimiter.
function providersOf(value) {
  const providers = Array.isArray(value?.providers) ? [...value.providers] : [];
  const identity = identityOf(value);
  if (identity.provider) providers.push(identity.provider);
  return [...new Set(providers.filter((p) => typeof p === "string" && p))].sort();
}

const displayOf = (identity) => identity.explicit && identity.provider
  ? `${identity.provider}/${identity.model}`
  : identity.model;
const compareIdentity = (a, b) => displayOf(identityOf(a)).localeCompare(displayOf(identityOf(b)));

export function coverage(report) {
  const aspects = report.aspects.map((a) => a.aspect);
  const modelProviders = new Map();
  for (const a of report.aspects) for (const c of a.cells) {
    const providers = modelProviders.get(c.model) || new Set();
    for (const provider of providersOf(c)) providers.add(provider);
    modelProviders.set(c.model, providers);
  }
  const models = [...modelProviders.keys()].sort();
  const identities = models.map((model) => ({
    model,
    label: model,
    providers: [...modelProviders.get(model)].sort(),
  }));
  const byKey = new Map();
  for (const a of report.aspects) for (const c of a.cells) byKey.set(JSON.stringify([a.aspect, c.model]), c);
  const cells = [];
  for (const model of models) {
    for (const aspect of aspects) {
      const c = byKey.get(JSON.stringify([aspect, model]));
      cells.push({
        model,
        label: model,
        providers: [...modelProviders.get(model)].sort(),
        aspect,
        n: c ? c.n : 0,
        provisional: c ? c.provisional : true,
      });
    }
  }
  return { aspects, models, identities, cells };
}

// Each deduped leaf (one row, however many aspects its grades cover) counts
// once — the aggregate report's per-aspect outcomes must never be summed
// across aspects, or an ungraded leaf multiplies by the aspect count.
export function reliability(liveRows) {
  const byModel = new Map();
  for (const r of liveRows) {
    const key = r.model;
    if (!byModel.has(key)) byModel.set(key, {
      model: r.model,
      label: r.model,
      providers: [],
      total: 0,
      byOutcome: blankOutcomes(),
    });
    const m = byModel.get(key);
    for (const provider of providersOf(r)) {
      if (!m.providers.includes(provider)) m.providers.push(provider);
    }
    m.providers.sort();
    m.total += 1;
    m.byOutcome[r.outcome] = (m.byOutcome[r.outcome] || 0) + 1;
  }
  return [...byModel.values()].sort((a, b) => b.total - a.total || compareIdentity(a, b));
}

// Top k by weighted score per aspect — the same ranking `swarm perf` shows,
// just capped. A cell with no grade (outcomes only) has nothing to lead with.
export function leaders(report, k = 3) {
  return report.aspects.map((a) => ({
      aspect: a.aspect,
      top: a.cells.filter((c) => c.weighted != null)
      .slice().sort((x, y) => y.weighted - x.weighted || compareIdentity(x, y))
      .slice(0, k)
      .map((c) => ({
        model: c.model,
        label: c.model,
        providers: providersOf(c),
        weighted: c.weighted,
        n: c.n,
        provisional: c.provisional,
      })),
  }));
}

// The cost read-model: quality is collapsed by model, while every cost row
// remains attached to its provider and compatible cost domain. A model with
// no multiplier is UNMEASURED, not free: it stays in `points` with
// `multiplier: null` so the page can draw it as a void, never a 0×.
export function costView(rows, costRows, { domain, costDomain, bands = DEFAULT_COST_BANDS, valueMargin, isDenylisted = () => false, cloudSuffix = ":cloud" } = {}) {
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
  const familyNames = new Map();
  for (const row of [...points, ...spread]) {
    const provider = providerKey(row);
    const names = familyNames.get(provider) || new Set();
    names.add(row.model);
    familyNames.set(provider, names);
  }
  for (const [provider, names] of familyNames) {
    const suffix = provider === "ollama" ? cloudSuffix : "";
    const families = collapseFamilies([...names].map((model) => ({ model })), suffix);
    const visible = new Set(visibleModels(families, { isDenylisted }).map((row) => row.model));
    const supersededBy = new Map(families
      .filter((row) => !visible.has(row.model) && row.supersededBy)
      .map((row) => [row.model, row.supersededBy]));
    for (const row of [...points, ...spread]) {
      if (providerKey(row) === provider && supersededBy.has(row.model)) {
        row.supersededBy = supersededBy.get(row.model);
      }
    }
  }

  // Verdicts are intentionally local. A single global best/worst would imply
  // that (say) an Ollama meter point and a Codex plan-rate point share a cost
  // axis, which they do not. When a caller asks for one provider/domain the
  // legacy top-level cards remain useful; mixed views expose provider sections
  // and leave the global cards null.
  const verdicts = (sectionPoints, sectionSpread) => {
    const domains = new Set(sectionSpread.map((row) => row.costDomain || "legacy"));
    if (domains.size > 1) return { best: null, worst: null };
    const candidates = sectionPoints.filter((p) => !p.supersededBy && p.onFrontier && p.multiplier != null && !p.thin);
    const topWtd = candidates.reduce((m, p) => (p.wtd > m ? p.wtd : m), -Infinity);
    const best = candidates.filter((p) => p.wtd >= topWtd - margin)
      .sort((a, z) => a.multiplier - z.multiplier || z.wtd - a.wtd || compareIdentity(a, z))[0] ?? null;
    const worst = sectionPoints.filter((p) => !p.supersededBy && p.dominatedBy != null)
      .sort((a, z) => z.multiplier - a.multiplier || a.wtd - z.wtd || compareIdentity(a, z))[0] ?? null;
    return { best, worst };
  };
  const providers = [...new Set([...points, ...costs].map(providerKey))].sort();
  for (const sectionProvider of providers) {
    const sectionPoints = points.filter((point) => providerKey(point) === sectionProvider);
    const participants = sectionPoints.filter((point) => !point.supersededBy && point.wtd != null && point.multiplier != null);
    const comparable = sectionPoints.filter((point) => point.wtd != null && point.multiplier != null);
    for (const point of comparable) {
      const dominator = participants.find((other) => other !== point
        && other.costDomain === point.costDomain
        && other.wtd > point.wtd
        && other.multiplier < point.multiplier);
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
  const global = providers.length === 1 ? verdicts(points, spread) : { best: null, worst: null };
  return {
    points, spread, sections, bands, valueMargin: margin,
    ...(costDomain !== undefined && { costDomain }),
    best: global.best,
    worst: global.worst,
  };
}
