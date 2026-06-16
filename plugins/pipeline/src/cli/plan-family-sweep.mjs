// plan-family-sweep.mjs — CLI: pipeline plan-family-sweep <project> [--apply] [--dry-run]
//
// For every umbrella plan (plans whose name appears as a parent in the
// directory), if ALL of its children are in `complete/`, move the umbrella
// + any active-plans siblings that share the parent annotation into
// `complete/`.
//
// Dry-run is the default. Pass `--apply` to actually rename. The sweep is
// idempotent: re-running it after a partial move is a no-op.
//
// What counts as "all children in complete":
//   1. Every plan whose filename infers this parent (phase/research-summary/
//      analysis/gemma/test-plan) is in complete/.
//   2. Every plan whose `*Parent:*` annotation names this parent is in
//      complete/.
// The umbrella's own status (active vs complete) is independent — this
// sweep moves the umbrella into complete/ when the children are.

import { existsSync, renameSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { resolvePlansDir } from "../plans-resolver.mjs";
import { lookupProjectOrFail } from "./project-lookup.mjs";
import { close } from "../../scripts/pipeline-db/index.mjs";
import {
  discoverFamilies, parsePlanFile,
} from "../../scripts/plans/family-parse.mjs";

export async function run(cmd, argv) {
  if (cmd !== "plan-family-sweep") return null;

  const [project] = argv;
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  const explicitDryRun = argv.includes("--dry-run") || argv.includes("--no-apply");
  // Default mode is dry-run; --apply flips it.
  const isDryRun = !apply;

  if (!project) {
    process.stderr.write(
      "usage: pipeline plan-family-sweep <project> [--apply] [--dry-run]\n"
    );
    return 1;
  }

  const ctx = lookupProjectOrFail(project);
  if (!ctx) return 1;
  try {
    const plansDir = resolvePlansDir({ project: ctx.project, projectRoot: ctx.projectRoot });
    const families = discoverFamilies(plansDir);

    const summary = { scanned: 0, ready: 0, moved: [], skipped: [] };

    for (const [parentStem, fam] of families) {
      summary.scanned++;
      if (!fam.parentPlan) continue; // orphan group; no umbrella to move
      if (fam.parentPlan.inComplete) continue; // already in complete/

      // Children must all be in complete/.
      const totalChildren = fam.children.length;
      const completedChildren = fam.children.filter(c => c.inComplete).length;
      if (totalChildren === 0) continue; // umbrella with no children — skip
      if (completedChildren !== totalChildren) continue; // some still active

      // Also pick up explicit-annotation siblings in the active dir.
      const explicitSiblings = explicitSiblingsInDir(plansDir, parentStem);
      if (explicitSiblings.length) {
        // If any explicit sibling is still active, the family is not ready.
        const allInComplete = explicitSiblings.every(s => s.inComplete);
        if (!allInComplete) continue;
      }

      summary.ready++;
      const moves = [];
      moves.push({ from: fam.parentPlan.planPath, to: join(plansDir, "complete", `${parentStem}.md`) });
      for (const c of fam.children.filter(c => !c.inComplete)) {
        // Shouldn't happen (filtered above), but defensive.
        moves.push({ from: c.planPath, to: join(plansDir, "complete", `${basename(c.planPath)}`) });
      }
      for (const s of explicitSiblings.filter(s => !s.inComplete)) {
        moves.push({ from: s.planPath, to: join(plansDir, "complete", `${basename(s.planPath)}`) });
      }

      if (isDryRun) {
        summary.moved.push({ parent: parentStem, moves: moves.map(m => ({ from: m.from, to: m.to })) });
        process.stdout.write(
          `would move ${moves.length} file(s) for family '${parentStem}':\n`
        );
        for (const m of moves) {
          process.stdout.write(`  ${m.from}\n    -> ${m.to}\n`);
        }
      } else {
        for (const m of moves) {
          try { renameSync(m.from, m.to); }
          catch (e) {
            summary.skipped.push({ parent: parentStem, file: m.from, reason: e.message });
          }
        }
        summary.moved.push({ parent: parentStem, moved: moves.length });
        process.stdout.write(`moved ${moves.length} file(s) for family '${parentStem}'\n`);
      }
    }

    if (isDryRun) {
      process.stdout.write(
        `\n[DRY RUN] ${summary.ready} family(ies) ready; ${summary.moved.reduce((a, m) => a + m.moves.length, 0)} file(s) would move. ` +
        `Re-run with --apply to perform the moves.\n`
      );
    } else {
      process.stdout.write(
        `\napplied: ${summary.moved.length} family(ies) moved; ` +
        `skipped: ${summary.skipped.length}.\n`
      );
    }
    return 0;
  } finally {
    close(ctx.db);
  }
}

// Plans that explicitly declare `*Parent:* <parentStem>` in their frontmatter
// but whose filename doesn't match a suffix pattern. Returned as
// { name, planPath, inComplete } for active- and complete-locations.
function explicitSiblingsInDir(plansDir, parentStem) {
  const out = [];
  for (const location of ["", "complete"]) {
    const dir = join(plansDir, location);
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const file of entries) {
      if (!file.endsWith(".md")) continue;
      const stem = file.slice(0, -3);
      if (stem === parentStem) continue;
      const planPath = join(dir, file);
      const parsed = parsePlanFile(planPath);
      if (parsed.parent === parentStem) {
        out.push({ name: stem, planPath, inComplete: location === "complete" });
      }
    }
  }
  return out;
}
