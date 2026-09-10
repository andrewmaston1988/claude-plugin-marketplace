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
    const head = `  ${model} (${(leaves || []).join(", ")})`;
    const entry = byModel.get(model);
    // No graded row at all: the whole line is the fact, in words — no digits,
    // no dash, nothing that reads as a score.
    if (!entry || entry.wtd == null) {
      lines.push(`${head} · never graded · ${costPart(model)}`);
      continue;
    }
    const parts = [
      `overall ${entry.wtd.toFixed(2)} ${nPart(entry.n)}`,
      colPart("impl", implCells.get(model)),
      colPart("code", codeCells.get(model)),
      costPart(model),
    ];
    if (entry.dominatedBy) parts.push(`dominated by ${entry.dominatedBy}`);
    else if (entry.onFrontier) parts.push("frontier");
    lines.push(`${head} · ${parts.join(" · ")}`);
  }

  const unseated = (roster || []).filter((m) => !seated.has(m.model));
  if (unseated.length) {
    const items = unseated.map((m) => {
      const entry = byModel.get(m.model);
      return entry && entry.n > 0 ? `${m.model} ${nPart(entry.n)}` : `${m.model} never graded`;
    });
    lines.push(`  launchable, not seated: ${items.join(" · ")}`);
  }

  return lines;
}