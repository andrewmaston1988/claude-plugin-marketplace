// The seats block `swarm validate` prints: the graded record of every seated
// model, from the same store `swarm perf` reads, at the moment the seating is
// being decided. It states the record and does not judge it — the seating rule
// deliberately gives an under-canon model the seat, so a bad-seat warning would
// fire on correct seats and be ignored on real ones. Pure over injected rows:
// no I/O, no store path.

import { aggregate, frontier, overall } from "./scores.mjs";
import { band, DEFAULT_COST_BANDS } from "./cost.mjs";
import { identityOf, identityKey, CLAUDE_ALIASES, claudeFamilyOf } from "./contracts.mjs";
import { collapseRoster } from "./discovery.mjs";
import { costView, verdictsIn } from "./cost-view.mjs";
import { successorPitch } from "./supersession.mjs";

// The seating canon: 20 graded runs per model per capability slot. Under it a
// grade is not a verdict — printed as n<20, the rule's own term, which reads as
// the argument FOR the seat.
const CANON_N = 20;

const nPart = (n) => `n=${n}${n < CANON_N ? " n<20" : ""}`;

// Unmeasured never renders as a number: 0.00 reads as terrible when it means
// unknown.
const colPart = (label, cell) =>
  cell && cell.n > 0 ? `${label} ${cell.weighted.toFixed(2)} ${nPart(cell.n)}` : `${label} unmeasured`;

// A manifest seats a Claude tier by ALIAS ("sonnet"); the store records the id
// the run resolved to ("claude-sonnet-5"). Exact-string lookup therefore reads
// a model with hundreds of graded rows as never graded — the same inversion
// row 3 guards against, one field over, and it would hand the exploration seat
// to the best-measured model on the roster. Match on the family token
// (contracts.mjs's claudeFamilyOf — positional, so an id that merely contains
// the token never matches), and take the id with the most rows: an alias means
// the tier's current model, which is the one still being graded. Non-alias
// names never take this path.

function shown(identity) {
  return identity.explicit && identity.provider ? `${identity.provider}/${identity.model}` : identity.model;
}

function entriesOf(byModel) {
  return [...(byModel || [])].map(([key, entry]) => {
    let parsed = null;
    try {
      const value = JSON.parse(key);
      if (Array.isArray(value) && value.length === 2) parsed = { provider: value[0], model: value[1] };
    } catch { /* legacy model key */ }
    const identity = identityOf(parsed || { ...entry, model: parsed?.model || key });
    return { key, entry, identity };
  });
}

// Returns the store's name for a seated model, or null when nothing matches.
// The caller PRINTS what this resolved to — a silent resolution is a guess the
// reader cannot check.
export function resolveSeatModel(name, byModel) {
  const target = identityOf(name);
  const entries = entriesOf(byModel);
  const exact = entries.find(({ identity }) => identity.model === target.model && (!target.provider || identity.provider === target.provider));
  if (exact) return exact.identity.model;
  if ((target.provider && target.provider !== "claude") || !CLAUDE_ALIASES.has(String(target.model || "").toLowerCase())) return null;
  const family = String(target.model).toLowerCase();
  let best = null;
  for (const { identity, entry } of entries) {
    if (identity.provider !== "claude" || claudeFamilyOf(identity.model) !== family) continue;
    if (!best || (entry.n || 0) > (best.entry.n || 0)) best = { identity, entry };
  }
  return best?.identity.model || null;
}

function resolveSeatIdentity(target, byIdentity) {
  const exact = byIdentity.get(identityKey(target));
  if (exact) return exact;
  if (target.provider !== "claude" || !CLAUDE_ALIASES.has(String(target.model || "").toLowerCase())) return null;
  const family = String(target.model).toLowerCase();
  return [...byIdentity.values()]
    .filter((entry) => entry.identity.provider === "claude" && claudeFamilyOf(entry.identity.model) === family)
    .sort((a, b) => (b.entry.n || 0) - (a.entry.n || 0))[0] || null;
}

// Launchable models short of the canon, each with the elder it would replace (the
// family member whose successor it is, read backwards) and that elder's record.
// Sorted best-value elder's successor, frontier elder's, the rest by elder rank, no elder last.
export function gapCandidates({ roster = [], rows = [], costRows = [], bands = DEFAULT_COST_BANDS, valueMargin, cloudSuffix } = {}) {
  if (!roster.length || !rows.length) return [];
  const byIdentity = new Map(frontier(rows, costRows, { bands })
    .map((e) => [identityKey(identityOf(e)), { identity: identityOf(e), entry: e }]));
  // Store rows join the roster so an elder that has left it is still found.
  const family = collapseRoster([...roster, ...[...byIdentity.values()].map(({ identity }) => identity)]
    .map((m) => {
      const identity = identityOf(m);
      return { ...(identity.provider ? { provider: identity.provider } : {}), model: identity.model };
    }));
  const elderOf = (identity) => family.find((row) => row.supersededBy === identity.model
    && (row.provider || "ollama") === (identity.provider || "ollama"))?.model || null;
  // The rank and verdict words are the table's and the Cost screen's own — the
  // combined-provider ranking and the same costView options the dashboard resolves.
  const rankOf = new Map(overall(rows, { combineProviders: true }).cells.map((cell, i) => [cell.model, i + 1]));
  const view = costRows.length ? costView(rows, costRows, { bands, valueMargin, cloudSuffix }) : null;
  const verdictsOf = (provider, model) => verdictsIn(
    view?.sections.find((s) => (s.provider || "unqualified") === (provider || "unqualified")), model);

  const candidates = [];
  for (const modelEntry of roster) {
    const target = identityOf(modelEntry);
    const resolved = resolveSeatIdentity(target, byIdentity);
    const n = resolved?.entry?.n ?? 0;
    if (n >= CANON_N) continue;
    const elder = elderOf(target);
    candidates.push({
      model: target.model,
      // Only a DECLARED provider rides along: writing an inferred one back would
      // flip the identity to explicit and print "ollama/kimi-k2.7-code:cloud".
      ...(target.explicit ? { provider: target.provider } : {}),
      n,
      elder,
      rank: elder ? rankOf.get(elder) ?? null : null,
      verdicts: elder ? verdictsOf(target.provider, elder) : [],
    });
  }
  const tier = (c) => (c.elder == null ? 3 : c.verdicts.includes("best value") ? 0 : c.verdicts.includes("frontier") ? 1 : 2);
  return candidates.sort((a, b) => tier(a) - tier(b)
    || (a.rank ?? Infinity) - (b.rank ?? Infinity)
    || a.n - b.n || a.model.localeCompare(b.model));
}

// The line's own instruction: the reader may have no skill or rule loaded, and
// the seating canon is exactly what a fresh author has not read.
const GAP_INSTRUCTION = "seat it on one bounded leaf this run; a grade at n<20 is not a verdict";

export function seatReport({ models = [], rows = [], costRows = [], roster = [], bands = DEFAULT_COST_BANDS, valueMargin, cloudSuffix } = {}) {
  if (!models.length || !rows.length) return [];

  // One record per model straight from the source aggregators: frontier's wtd
  // IS overall's combined (it derives from it), plus the cost verdict. Never
  // recompute a copy — the copy is what drifts.
  const frontierRows = frontier(rows, costRows, { bands });
  const byIdentity = new Map(frontierRows.map((e) => [identityKey(identityOf(e)), { identity: identityOf(e), entry: e }]));
  const implCells = new Map(aggregate(rows, { aspect: "impl" }).aspects[0].cells.map((c) => [identityKey(identityOf(c)), c]));
  const codeCells = new Map(aggregate(rows, { aspect: "code" }).aspects[0].cells.map((c) => [identityKey(identityOf(c)), c]));

  // Cost is known independently of grades: a never-graded model with a history
  // still shows its band, and a graded model without one shows unmeasured.
  const multOf = new Map((costRows || []).map((c) => [identityKey(identityOf(c)), c]));
  const costPart = (identity) => {
    const cost = multOf.get(identityKey(identity));
    const b = cost ? band(cost.mult, bands) : null;
    return b ? `cost ${"$".repeat(b)}` : "cost unmeasured";
  };

  const lines = ["seats:"];
  const seated = new Set(models.map((m) => identityKey(identityOf(m))));
  for (const modelEntry of models) {
    const target = identityOf(modelEntry);
    const resolved = resolveSeatIdentity(target, byIdentity);
    const resolvedIdentity = resolved?.identity || target;
    const resolvedName = resolved && identityKey(resolvedIdentity) !== identityKey(target)
      ? `${shown(target)} -> ${shown(resolvedIdentity)}` : shown(target);
    const head = `  ${resolvedName} (${(modelEntry.leaves || []).join(", ")})`;
    const entry = resolved?.entry || null;
    // No graded row at all: the whole line is the fact, in words — no digits,
    // no dash, nothing that reads as a score.
    if (!entry || entry.wtd == null) {
      lines.push(`${head} · never graded · ${costPart(resolvedIdentity)}`);
      continue;
    }
    const parts = [
      `overall ${entry.wtd.toFixed(2)} ${nPart(entry.n)}`,
      colPart("impl", implCells.get(identityKey(resolvedIdentity))),
      colPart("code", codeCells.get(identityKey(resolvedIdentity))),
      costPart(resolvedIdentity),
    ];
    if (entry.dominatedBy) parts.push(`dominated by ${entry.dominatedBy}`);
    else if (entry.onFrontier) parts.push("frontier");
    lines.push(`${head} · ${parts.join(" · ")}`);
  }

  const unseated = (roster || []).filter((m) => !seated.has(identityKey(identityOf(m))));
  // The manifest that already seats a model short of the canon needs no nudge —
  // the seat is taken — so the line only fires when every gap is still open.
  const gaps = gapCandidates({ roster, rows, costRows, bands, valueMargin, cloudSuffix });
  const gap = gaps.some((c) => seated.has(identityKey(identityOf(c)))) ? null : gaps[0] ?? null;
  if (gap) {
    const state = gap.n > 0 ? nPart(gap.n) : "never graded";
    lines.push(`  gap seat available: ${shown(identityOf(gap))} (${state}) — ${successorPitch(gap)} · ${GAP_INSTRUCTION}`);
  }
  const rest = gap ? unseated.filter((m) => identityKey(identityOf(m)) !== identityKey(identityOf(gap))) : unseated;
  if (rest.length) {
    const items = rest.map((m) => {
      const resolved = resolveSeatIdentity(identityOf(m), byIdentity);
      const entry = resolved?.entry || null;
      return entry && entry.n > 0 ? `${shown(identityOf(m))} ${nPart(entry.n)}` : `${shown(identityOf(m))} never graded`;
    });
    lines.push(`  launchable, not seated: ${items.join(" · ")}`);
  }

  return lines;
}
