// The outcome tail on a `swarm perf` row, shared by both tables (`--overall`
// and per-aspect) so the two render the same tally.
//
// Infra outcomes (quota / rate-limited / harness) are excluded from every cell
// by scores.mjs — the leaf never got to try, so its death is not evidence about
// the model. They are printed once per model as `infra n` instead: visible in
// the row without a provider outage reading as an adherence grade.
import { INFRA_OUTCOMES } from "./aspects.mjs";

/** The trailing `· wrong 2, infra 3` for one cell, or "" when there is none.
 *  Returned undimmed — the caller owns the styling and must not dim "". */
export function outcomeTail(cell, report) {
  const bad = Object.entries(cell.outcomes)
    .filter(([k, v]) => v > 0 && k !== "completed" && !INFRA_OUTCOMES.includes(k));
  const infra = report.infra.find((e) => e.model === cell.model)?.n ?? 0;
  const parts = [...bad.map(([k, v]) => `${k} ${v}`), ...(infra ? [`infra ${infra}`] : [])];
  return parts.length ? `  · ${parts.join(", ")}` : "";
}
