// The `swarm perf` row tail. Infra outcomes are tallied apart, never on a cell:
// the leaf never got to try, so its death is not evidence about the model.
import { INFRA_OUTCOMES } from "./aspects.mjs";
import { dim } from "./ui.mjs";

/** The trailing `· wrong 2, infra 3` for one cell, or "" when there is none.
 *  Returned undimmed — the caller owns the styling and must not dim "".
 *  `includeInfra: false` leaves the tally to `infraFooter`, which prints it once
 *  for the whole table rather than on every aspect row the model appears in. */
export function outcomeTail(cell, report, { includeInfra = true } = {}) {
  const bad = Object.entries(cell.outcomes)
    .filter(([k, v]) => v > 0 && k !== "completed" && !INFRA_OUTCOMES.includes(k));
  const infra = includeInfra ? report.infra.find((e) => e.model === cell.model)?.n ?? 0 : 0;
  const parts = [...bad.map(([k, v]) => `${k} ${v}`), ...(infra ? [`infra ${infra}`] : [])];
  return parts.length ? `  · ${parts.join(", ")}` : "";
}

/** The lines printed under the per-aspect tables: one infra tally for the whole
 *  table, then the legend. Returns the legend alone when nothing was infra. */
export function infraFooter(report, legend) {
  const tally = report.infra.length
    ? `infra outcomes (not graded): ${report.infra.map((e) => `${e.model} ${e.n}`).join(", ")}`
    : null;
  return [tally, legend].filter(Boolean).map(dim);
}
