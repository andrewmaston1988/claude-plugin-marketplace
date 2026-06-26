// lint-plan-family.mjs — CLI: pipeline lint-plan-family [<project>] [--plans-dir <path>]
//
// Lint the plans directory for parent/child annotation hygiene:
//   1. Any plan whose name matches a child suffix pattern
//      (`-phase-N-*`, `-research-summary`, `-analysis`, `-gemma`, `-test-plan`)
//      MUST carry a `*Parent:*` annotation in its first 30 lines.
//   2. Any plan that declares `*Parent:* <X>` MUST reference a real plan file
//      (the umbrella must exist as a .md file in active or complete/).
//
// Exit code 0 on clean; 1 if any violation is found. Violations are printed
// to stderr in plain text. Use --json to emit a JSON array of violations
// for programmatic consumption.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePlansDir } from "../plans-resolver.mjs";
import { lookupProjectOrFail } from "./project-lookup.mjs";
import { close } from "../db/index.mjs";
import {
  parsePlanFile, requiresParentAnnotation, readParentAnnotation, inferParentStem,
} from "../plans/family-parse.mjs";
import { getFlag } from "./helpers.mjs";

export async function run(cmd, argv) {
  if (cmd !== "lint-plan-family") return null;

  const project = argv[0];
  const plansDirFlag = getFlag("--plans-dir", argv);
  const jsonOut = argv.includes("--json");
  const quiet = argv.includes("--quiet");

  if (!project) {
    process.stderr.write(
      "usage: pipeline lint-plan-family <project> [--plans-dir <path>] [--json] [--quiet]\n"
    );
    return 1;
  }

  const ctx = lookupProjectOrFail(project);
  if (!ctx) return 1;
  try {
    const plansDir = plansDirFlag || resolvePlansDir({
      project: ctx.project, projectRoot: ctx.projectRoot,
    });

    const violations = [];

    for (const location of ["", "complete"]) {
      const dir = join(plansDir, location);
      let entries;
      try { entries = readdirSync(dir); } catch { continue; }

      for (const file of entries) {
        if (!file.endsWith(".md")) continue;
        const stem = file.slice(0, -3);
        const planPath = join(dir, file);
        const content = readFileSync(planPath, "utf8");
        const parent = readParentAnnotation(content);

        // Rule 1: child-by-name must declare a parent.
        if (requiresParentAnnotation(stem) && !parent) {
          violations.push({
            rule: "missing-parent-annotation",
            file: planPath,
            name: stem,
            detail: `name matches child pattern but has no '*Parent:*' annotation`,
          });
        }

        // Rule 2: declared parent must reference a real umbrella file.
        if (parent) {
          const parentStem = parent;
          const parentActive   = join(plansDir, `${parentStem}.md`);
          const parentComplete = join(plansDir, "complete", `${parentStem}.md`);
          if (!existsSync(parentActive) && !existsSync(parentComplete)) {
            violations.push({
              rule: "parent-not-found",
              file: planPath,
              name: stem,
              detail: `declares parent '${parentStem}' but no such plan file exists`,
            });
          }
        }
      }
    }

    if (jsonOut) {
      process.stdout.write(JSON.stringify(violations, null, 2) + "\n");
    } else if (!quiet && violations.length) {
      for (const v of violations) {
        process.stderr.write(`${v.rule}: ${v.file}\n  ${v.detail}\n`);
      }
    } else if (!quiet) {
      process.stdout.write("ok — no family annotation violations\n");
    }

    return violations.length ? 1 : 0;
  } finally {
    close(ctx.db);
  }
}
