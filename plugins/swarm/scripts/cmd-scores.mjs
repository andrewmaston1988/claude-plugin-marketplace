// `swarm scores backfill-realmodel` — split out of swarm.mjs, which just dispatches
// to it, the same shape as cmd-report.mjs. The score modules stay lazily imported
// inside the command, so no other subcommand pays for loading them.
import { out, err } from "../src/ui.mjs";

// `scores backfill-realmodel` — repair rows filed under a bare Claude alias
// (`opus`, `sonnet`, `haiku`) by reading the concrete model each leaf's OWN
// transcript reports. Those rows predate the rule that stopped them being
// written; until they are rewritten, overall()/frontier() rank the alias as a
// rival model. A row whose transcript names no model is dropped, never guessed.
// --dry-run prints the mapping and touches nothing at all.
export async function cmdScoresRealmodel(rest) {
  const dryRun = rest.includes("--dry-run");
  const { readFileSync, writeFileSync, copyFileSync, existsSync } = await import("node:fs");
  const { scoresPath } = await import("../src/scores.mjs");
  const { backfillRealmodel } = await import("../src/scores-backfill.mjs");
  const { transcriptPath } = await import("../src/results.mjs");

  const path = scoresPath();
  if (!existsSync(path)) {
    err(`swarm: no score store at ${path} — nothing to backfill.`);
    return 1;
  }
  const before = readFileSync(path, "utf8");
  const plan = backfillRealmodel(before, {
    // Unreadable is null, not "": a row that cannot be read must never look like
    // a row that was read and named nothing.
    readTranscript: (resultsDir, leaf) => {
      try { return readFileSync(transcriptPath(resultsDir, leaf), "utf8"); } catch { return null; }
    },
  });

  for (const { alias, model, n } of plan.mapping) out(`${alias} -> ${model} (${n})`);
  for (const d of plan.dropped) out(`dropped: ${d.alias} ${d.leaf} @ ${d.resultsDir} — ${d.reason}`);
  out(`${plan.changed} row(s) resolved, ${plan.dropped.length} dropped${dryRun ? " — dry run, nothing written" : ""}`);
  if (dryRun) return 0;

  // Nothing resolved and nothing to drop is a no-op: re-running must not mint a
  // backup of an unchanged store.
  if (!plan.changed && !plan.dropped.length) {
    out("nothing to backfill — no alias-named rows in the store.");
    return 0;
  }
  const bak = `${path}.bak-${Date.now()}`;
  copyFileSync(path, bak);
  writeFileSync(path, plan.text);
  out(`backup: ${bak}`);
  out(`rewrote ${path}`);
  return 0;
}
