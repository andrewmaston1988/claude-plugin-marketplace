// The seats block `swarm validate` prints: the graded record of every seated
// model, from the same store `swarm perf` reads, at the moment the seating is
// being decided. It states the record and does not judge it — the seating rule
// deliberately gives an under-canon model the seat, so a bad-seat warning would
// fire on correct seats and be ignored on real ones. Pure over injected rows:
// no I/O, no store path.

import { aggregate, frontier } from "./scores.mjs";
import { band, DEFAULT_COST_BANDS } from "./cost.mjs";

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
// to the best-measured model on the roster. Match on the family token, as the
// quota preflight already does for the same alias/id split, and take the id
// with the most rows: an alias means the tier's current model, which is the one
// still being graded. Non-alias names never take this path.
const CLAUDE_ALIAS_RE = /^(fable|opus|sonnet|haiku)$/i;

// Returns the store's name for a seated model, or null when nothing matches.
// The caller PRINTS what this resolved to — a silent resolution is a guess the
// reader cannot check.
export function resolveSeatModel(name, byModel) {
  if (byModel.has(name)) return name;
  if (!CLAUDE_ALIAS_RE.test(String(name || ""))) return null;
  const family = String(name).toLowerCase();
  let best = null;
  for (const [model, entry] of byModel) {
    if (!String(model).toLowerCase().includes(family)) continue;
    if (!best || (entry.n || 0) > (byModel.get(best).n || 0)) best = model;
  }
  return best;
}

export function seatReport({ models = [], rows = [], costRows = [], roster = [], bands = DEFAULT_COST_BANDS } = {}) {
  if (!models.length || !rows.length) return [];

  // One record per model straight from the source aggregators: frontier's wtd
  // IS overall's combined (it derives from it), plus the cost verdict. Never
  // recompute a copy — the copy is what drifts.
  const byModel = new Map(frontier(rows, costRows, { bands }).map((e) => [e.model, e]));
  const implCells = new Map(aggregate(rows, { aspect: "impl" }).aspects[0].cells.map((c) => [c.model, c]));
  const codeCells = new Map(aggregate(rows, { aspect: "code" }).aspects[0].cells.map((c) => [c.model, c]));

  // Cost is known independently of grades: a never-graded model with a history
  // still shows its band, and a graded model without one shows unmeasured.
  const multOf = new Map((costRows || []).map((c) => [c.model, c.mult]));
  const costPart = (model) => {
    const b = multOf.has(model) ? band(multOf.get(model), bands) : null;
    return b ? `cost ${"$".repeat(b)}` : "cost unmeasured";
  };

  const lines = ["seats:"];
  const seated = new Set(models.map((m) => m.model));
  for (const { model, leaves } of models) {
    const key = resolveSeatModel(model, byModel);
    const shown = key && key !== model ? `${model} -> ${key}` : model;
    const head = `  ${shown} (${(leaves || []).join(", ")})`;
    const entry = key ? byModel.get(key) : null;
    // No graded row at all: the whole line is the fact, in words — no digits,
    // no dash, nothing that reads as a score.
    if (!entry || entry.wtd == null) {
      lines.push(`${head} · never graded · ${costPart(key || model)}`);
      continue;
    }
    const parts = [
      `overall ${entry.wtd.toFixed(2)} ${nPart(entry.n)}`,
      colPart("impl", implCells.get(key)),
      colPart("code", codeCells.get(key)),
      costPart(key),
    ];
    if (entry.dominatedBy) parts.push(`dominated by ${entry.dominatedBy}`);
    else if (entry.onFrontier) parts.push("frontier");
    lines.push(`${head} · ${parts.join(" · ")}`);
  }

  const unseated = (roster || []).filter((m) => !seated.has(m.model));
  if (unseated.length) {
    const items = unseated.map((m) => {
      const key = resolveSeatModel(m.model, byModel);
      const entry = key ? byModel.get(key) : null;
      return entry && entry.n > 0 ? `${m.model} ${nPart(entry.n)}` : `${m.model} never graded`;
    });
    lines.push(`  launchable, not seated: ${items.join(" · ")}`);
  }

  return lines;
}