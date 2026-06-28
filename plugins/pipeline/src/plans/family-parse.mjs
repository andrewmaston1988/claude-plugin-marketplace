// family-parse.mjs — parse a plan file's frontmatter-like annotation block.
//
// Returns { name, parent, stem } for a single .md file. The `*Parent:*` line
// is parsed from the file's first 30 lines (the annotation header block).
// Naming-inference helpers also live here so `plan-family` and the linter
// share the same source of truth.
//
// Convention (locked in plan-family-tracking):
//   *Parent:* <parent-name>
//
// Examples:
//   # Plan: pipeline-effort-dimension — Phase 1 — Schema & CLI
//   *Parent:* `pipeline-effort-dimension.md`
//
// Children-by-inference patterns — a plan is treated as a child if its name
// matches `<parent>-phase-N-*`, `<parent>-research-summary`, `<parent>-analysis`,
// `<parent>-gemma`, or `<parent>-test-plan`. The first segment before the
// first `-phase-` is the candidate parent. Suffixes are matched as exact
// stem endings.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const HEADER_SCAN_LINES = 30;
const PARENT_REGEX = /^\*Parent:\*?\s+`?([A-Za-z0-9._-]+?)(?:\.md)?`?\s*$/m;

export function parsePlanFile(planPath) {
  const name = basename(planPath, ".md");
  let content = "";
  try { content = readFileSync(planPath, "utf8"); } catch { return { name, parent: null }; }

  const head = content.split(/\r?\n/).slice(0, HEADER_SCAN_LINES).join("\n");
  const m = head.match(PARENT_REGEX);
  if (!m) return { name, parent: null };
  const parentName = m[1];
  // If the parent reference is the same as this plan's name, treat as no parent.
  if (parentName === name) return { name, parent: null };
  return { name, parent: parentName };
}

// Plan is a child of <parent> by naming inference. Strict prefix match:
// the plan's stem must begin with `<parent>-` AND have one of the
// recognised suffix segments. `parent` here is the parent's stem (no .md).
export const CHILD_SUFFIX_PATTERNS = [
  /^.+-phase-\d+(?:-[a-z0-9-]+)?$/,      // foo-phase-1-schema, foo-phase-2-foo-bar
  /^[A-Za-z0-9-]+-research-summary$/,
  /^[A-Za-z0-9-]+-analysis$/,
  /^[A-Za-z0-9-]+-gemma$/,
  /^[A-Za-z0-9-]+-test-plan$/,
];

// Walk the plans directory (active + complete) and group by inferred parent.
// Returns Map<parentName, { parentPlan, children[] }>.
// `parentPlan` is null when only the children exist (orphan grouping).
// Each child carries { name, planPath, inComplete }.
export function discoverFamilies(plansDir) {
  const result = new Map();

  for (const location of ["", "complete"]) {
    const dir = join(plansDir, location);
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }

    for (const file of entries) {
      if (!file.endsWith(".md")) continue;
      const stem = file.slice(0, -3);
      const planPath = join(dir, file);
      const inComplete = location === "complete";

      const parentStem = inferParentStem(stem);
      if (!parentStem) continue;

      // If the file itself IS the parent (by name equality), skip — the
      // parent plan will be added explicitly when its own file is scanned.
      if (stem === parentStem) {
        if (!result.has(stem)) result.set(stem, { parentPlan: null, children: [] });
        const slot = result.get(stem);
        if (!slot.parentPlan || (inComplete && !slot.parentPlan.inComplete)) {
          slot.parentPlan = { name: stem, planPath, inComplete };
        }
        continue;
      }

      if (!result.has(parentStem)) result.set(parentStem, { parentPlan: null, children: [] });
      result.get(parentStem).children.push({ name: stem, planPath, inComplete });
    }
  }

  return result;
}

// If `stem` is a child by naming convention, return the parent's stem; else null.
export function inferParentStem(stem) {
  for (const re of CHILD_SUFFIX_PATTERNS) {
    if (!re.test(stem)) continue;
    // Strip the suffix segment to derive the parent.
    // Order matters: more-specific patterns first.
    const phaseMatch = stem.match(/^(.+?)-phase-\d+(?:-[a-z0-9-]+)?$/);
    if (phaseMatch) return phaseMatch[1];
    for (const suffix of ["-research-summary", "-analysis", "-gemma", "-test-plan"]) {
      if (stem.endsWith(suffix)) return stem.slice(0, -suffix.length);
    }
  }
  return null;
}

// Returns true when the plan file is a "child" of the named parent — either by
// explicit `*Parent:*` annotation or by naming inference.
export function belongsToFamily(planPath, parentName) {
  const { name, parent } = parsePlanFile(planPath);
  if (parent === parentName) return true;
  if (inferParentStem(name) === parentName) return true;
  return false;
}

// Helper: read parent annotation only, no file IO on the file under test.
export function readParentAnnotation(content) {
  const head = content.split(/\r?\n/).slice(0, HEADER_SCAN_LINES).join("\n");
  const m = head.match(PARENT_REGEX);
  return m ? m[1] : null;
}

// Determine whether a plan file's name matches a child pattern that should
// require a `*Parent:*` annotation. Used by the linter.
export function requiresParentAnnotation(stem) {
  return inferParentStem(stem) !== null;
}

// Exported for unit tests.
export const _internal = { PARENT_REGEX, HEADER_SCAN_LINES };
