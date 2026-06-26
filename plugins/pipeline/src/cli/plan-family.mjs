// plan-family.mjs — CLI: pipeline plan-family <parent> [--format json|plain]
//
// Lists the umbrella plan and all of its children (by `*Parent:*` annotation
// or naming inference), joined against pipeline DB rows for current stage.
// Output is deterministic — sorted by child name, then by inComplete (active
// first).

import { resolvePlansDir } from "../plans-resolver.mjs";
import { lookupProjectOrFail } from "./project-lookup.mjs";
import { getFlag } from "./helpers.mjs";
import { rowsList, close } from "../db/index.mjs";
import { discoverFamilies, parsePlanFile } from "../plans/family-parse.mjs";
import { existsSync, readdirSync } from "node:fs";

export async function run(cmd, argv) {
  if (cmd !== "plan-family") return null;

  const [project, parentArg] = argv;
  const format = getFlag("--format", argv) || "plain";

  if (!project || !parentArg) {
    process.stderr.write("usage: pipeline plan-family <project> <parent> [--format json|plain]\n");
    return 1;
  }
  if (format !== "json" && format !== "plain") {
    process.stderr.write(`error: --format must be 'json' or 'plain' (got '${format}')\n`);
    return 1;
  }

  const ctx = lookupProjectOrFail(project);
  if (!ctx) return 1;
  try {
    const plansDir = resolvePlansDir({ project: ctx.project, projectRoot: ctx.projectRoot });
    const parentStem = parentArg.replace(/\.md$/, "");

    const families = discoverFamilies(plansDir);
    const family = families.get(parentStem);

    // Build a feature→row lookup. Match by plan filename stem.
    const rowByFeature = new Map();
    try {
      for (const r of rowsList(ctx.db, ctx.project)) {
        if (r.feature) rowByFeature.set(r.feature, r);
      }
    } catch (e) {
      process.stderr.write(`warning: could not load pipeline rows: ${e.message}\n`);
    }

    // Find the umbrella plan itself (active or complete).
    const activeParentPath = `${plansDir}/${parentStem}.md`;
    const completeParentPath = `${plansDir}/complete/${parentStem}.md`;
    let parentPlan = null;
    if (existsSync(activeParentPath)) parentPlan = { name: parentStem, planPath: activeParentPath, inComplete: false };
    else if (existsSync(completeParentPath)) parentPlan = { name: parentStem, planPath: completeParentPath, inComplete: true };

    // If umbrella plan file does not exist but children do, surface that.
    if (!parentPlan && family && family.children.length) {
      parentPlan = { name: parentStem, planPath: null, inComplete: null, inferred: true };
    }

    const children = (family?.children || []).slice().sort((a, b) => {
      if (a.inComplete !== b.inComplete) return a.inComplete ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    // Try to also pick up explicitly-annotated children that naming
    // inference missed (e.g. a child with `*Parent:*` annotation whose
    // filename doesn't fit any suffix pattern).
    const explicitChildren = [];
    for (const location of ["", "complete"]) {
      const dir = `${plansDir}/${location}`;
      let entries;
      try { entries = readdirSync(dir); } catch { continue; }
      for (const file of entries) {
        if (!file.endsWith(".md")) continue;
        const stem = file.slice(0, -3);
        if (stem === parentStem) continue;
        if (children.some(c => c.name === stem)) continue; // already covered
        const planPath = `${dir}/${file}`;
        const parsed = parsePlanFile(planPath);
        if (parsed.parent === parentStem) {
          explicitChildren.push({ name: stem, planPath, inComplete: location === "complete" });
        }
      }
    }
    explicitChildren.sort((a, b) => a.name.localeCompare(b.name));

    const allChildren = [...children, ...explicitChildren];

    const result = {
      project: ctx.project,
      parent: parentPlan ? {
        name: parentPlan.name,
        plan_file: parentPlan.planPath,
        in_complete: parentPlan.inComplete === true,
        inferred: !!parentPlan.inferred,
        row: rowFor(parentPlan.name, rowByFeature),
      } : null,
      children: allChildren.map(c => ({
        name: c.name,
        plan_file: c.planPath,
        in_complete: c.inComplete,
        row: rowFor(c.name, rowByFeature),
      })),
    };

    if (format === "json") {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      renderPlain(result);
    }
    return 0;
  } finally {
    close(ctx.db);
  }
}

function rowFor(name, rowByFeature) {
  const r = rowByFeature.get(name);
  if (!r) return null;
  return {
    stage: r.stage,
    branch: r.branch,
    qa_pass: r.qa_pass,
    review_verdict: r.review_verdict,
  };
}

function renderPlain(r) {
  process.stdout.write(`Project: ${r.project}\n`);
  if (!r.parent) {
    process.stdout.write(`Parent: (not found — no umbrella plan file or children)\n`);
    return;
  }
  const p = r.parent;
  process.stdout.write(`Parent: ${p.name}${p.inferred ? "  (inferred — no umbrella plan file)" : ""}\n`);
  process.stdout.write(`  file:      ${p.plan_file || "(none)"}\n`);
  process.stdout.write(`  in_complete: ${p.in_complete}\n`);
  if (p.row) {
    process.stdout.write(`  stage:     ${p.row.stage || "—"}\n`);
    process.stdout.write(`  branch:    ${p.row.branch || "—"}\n`);
  } else {
    process.stdout.write(`  (no pipeline row)\n`);
  }
  process.stdout.write(`\nChildren (${r.children.length}):\n`);
  if (!r.children.length) {
    process.stdout.write(`  (none)\n`);
    return;
  }
  for (const c of r.children) {
    process.stdout.write(`  - ${c.name}\n`);
    process.stdout.write(`      file:        ${c.plan_file}\n`);
    process.stdout.write(`      in_complete: ${c.in_complete}\n`);
    if (c.row) {
      process.stdout.write(`      stage:       ${c.row.stage || "—"}\n`);
      process.stdout.write(`      branch:      ${c.row.branch || "—"}\n`);
      process.stdout.write(`      qa_pass:     ${c.row.qa_pass == null ? "—" : (c.row.qa_pass ? "true" : "false")}\n`);
    } else {
      process.stdout.write(`      (no pipeline row)\n`);
    }
  }
}
