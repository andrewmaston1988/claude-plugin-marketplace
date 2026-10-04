// `swarm report <resultsDir>` — split out of swarm.mjs, which just dispatches to it, the same
// shape as cmd-status.mjs. Renders a finished run's pages; the backfill for runs that predate them.
import { basename } from "node:path";
import { out, err } from "../src/ui.mjs";

export async function cmdReport(rest) {
  const { renderRunPages } = await import("../src/md_to_html.mjs");
  let written;
  try {
    written = renderRunPages(rest[0], { runName: basename(rest[0]) });
  } catch (e) {
    err(`swarm: ${e.message}`);
    return 1;
  }
  if (!written.length) {
    err(`swarm: no digest.md or report.md in ${rest[0]} — the run has not finished, or it wrote neither document.`);
    return 1;
  }
  for (const p of written) out(p);
  return 0;
}
