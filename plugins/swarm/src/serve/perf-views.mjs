// Read-models over scores.mjs's own aggregate/dedupe output, computed
// server-side so the page never re-derives a count it could get wrong.
import { OUTCOMES, INFRA_OUTCOMES } from "../aspects.mjs";
import { supersessionReading, supersessionKey, successorPitch } from "../supersession.mjs";
import { readyFrom, providersOf, compareIdentity, verdictsIn } from "../cost-view.mjs";

const blankOutcomes = () => Object.fromEntries(OUTCOMES.map((o) => [o, 0]));

// The Performance ranking's cells: a ranked row leaves the list while a newer
// sibling is present, and carries `supersededBy` so the toggle can bring it
// back. The denylist is not consulted: the ranking is a grade record, not a
// dispatch roster. A cell spanning more than one provider has no single naming rule, so it
// compares bare alongside the unqualified rows.
// `view` is the costView of the same rows: the elder's verdicts are read from it,
// so Perf prints the chip Cost prints.
export function rankCells(cells, { cloudSuffix = ":cloud", view = null } = {}) {
  const providerOf = (cell) => {
    const providers = providersOf(cell);
    return providers.length === 1 ? providers[0] : "unqualified";
  };
  const { superseded, pending } = supersessionReading(cells, {
    providerKey: providerOf, cloudSuffix, ready: readyFrom(cells, providerOf),
  });
  const rankOf = new Map(cells.map((cell, i) => [cell.model, i + 1]));
  // A young successor wears its elder's pitch.
  const pitchOf = new Map();
  for (const [key, successor] of pending) {
    const [provider, elder] = JSON.parse(key);
    const section = view?.sections.find((s) => (s.provider || "unqualified") === provider);
    pitchOf.set(supersessionKey(provider, successor), successorPitch({ elder, rank: rankOf.get(elder), verdicts: verdictsIn(section, elder) }));
  }
  return cells.map((cell) => {
    const key = supersessionKey(providerOf(cell), cell.model);
    const by = superseded.get(key);
    const next = pending.get(key);
    const pitch = pitchOf.get(key);
    if (by) return { ...cell, supersededBy: by };
    return next || pitch ? { ...cell, ...(next && { pendingSuccessor: next }), ...(pitch && { pitch }) } : cell;
  });
}
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
// `infra` is the three machinery outcomes summed: the bar draws one neutral
// segment for them, so the vocabulary is collapsed here rather than duplicated
// into perf.js, which loads as a browser script with no module imports.
export function reliability(liveRows) {
  const byModel = new Map();
  for (const r of liveRows) {
    const key = r.model;
    if (!byModel.has(key)) byModel.set(key, {
      model: r.model,
      label: r.model,
      providers: [],
      total: 0,
      infra: 0,
      byOutcome: blankOutcomes(),
    });
    const m = byModel.get(key);
    for (const provider of providersOf(r)) {
      if (!m.providers.includes(provider)) m.providers.push(provider);
    }
    m.providers.sort();
    // `total` is the GRADED count: the page reads it as "graded", and a provider
    // outage must not drag the completed ratio down. Infra still gets its own
    // count, so the bar can draw it as the neutral segment it is.
    if (INFRA_OUTCOMES.includes(r.outcome)) m.infra += 1;
    else m.total += 1;
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
