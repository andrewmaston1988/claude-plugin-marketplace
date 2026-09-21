// The seats block `swarm validate` prints: the graded record of every seated
// model, from the same store `swarm perf` reads, at the moment the seating is
// being decided. It states the record and does not judge it — the seating rule
// deliberately gives an under-canon model the seat, so a bad-seat warning would
// fire on correct seats and be ignored on real ones. Pure over injected rows:
// no I/O, no store path.

import { aggregate, frontier } from "./scores.mjs";
import { band, DEFAULT_COST_BANDS } from "./cost.mjs";
import { identityOf, identityKey, CLAUDE_ALIASES, claudeFamilyOf } from "./contracts.mjs";

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

export function seatReport({ models = [], rows = [], costRows = [], roster = [], bands = DEFAULT_COST_BANDS } = {}) {
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
  if (unseated.length) {
    const items = unseated.map((m) => {
      const resolved = resolveSeatIdentity(identityOf(m), byIdentity);
      const entry = resolved?.entry || null;
      return entry && entry.n > 0 ? `${shown(identityOf(m))} ${nPart(entry.n)}` : `${shown(identityOf(m))} never graded`;
    });
    lines.push(`  launchable, not seated: ${items.join(" · ")}`);
  }

  return lines;
}
