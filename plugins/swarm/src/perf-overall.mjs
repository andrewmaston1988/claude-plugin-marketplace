// The `swarm perf --overall` view: the ranked table, opened by the needs-grades
// block. Lives beside gapCandidates, which decides the block.
import { overall } from "./scores.mjs";
import { DEFAULT_COST_BANDS } from "./cost.mjs";
import { gapCandidates } from "./seats.mjs";
import { successorPitch } from "./supersession.mjs";

// The block names every launchable model still short of the canon — read from the
// WHOLE store, never the filtered view, so a filter cannot relabel a well-graded
// model as needing grades. Those models are held out of the ranking beneath, and
// the elder each would replace is marked `supersededBy`, so its own row says what
// took its place. `swarm validate` reads the same gap list. `out` is injected —
// the module decides the lines, the caller owns the destination.
const NEEDS_GRADES = "needs grades — seat one of these on a bounded leaf in your next run — they cannot rank until graded";

export function perfOverall({ cfg, roster = [], rows = [], costRows = [], bands = DEFAULT_COST_BANDS, valueMargin, cloudSuffix, model, domain, out = () => {} } = {}) {
  // One table: models ranked on the mean of the four universal weighted scores;
  // per-aspect columns beside it so the average cannot hide a hole.
  const table = overall(rows, { model, domain, combineProviders: true });
  const gaps = cfg?.grading?.enabled === true
    ? gapCandidates({ roster, rows, costRows, bands, valueMargin, cloudSuffix })
    : [];
  if (gaps.length) {
    out(NEEDS_GRADES);
    for (const g of gaps) out(`    ${g.model}  ${g.elder ? `n=${g.n}  ` : ""}${successorPitch(g)}`);
    out("");
  }
  // An explicit --model names the row the reader asked for; holding it out would print an empty table.
  const held = new Set(gaps.map((g) => g.model).filter((m) => m !== model));
  const supersededBy = new Map(gaps.filter((g) => g.elder).map((g) => [g.elder, g.model]));
  for (const cell of table.cells) {
    if (supersededBy.has(cell.model)) cell.supersededBy = supersededBy.get(cell.model);
  }
  table.cells = table.cells.filter((c) => !held.has(c.model));
  return table;
}
