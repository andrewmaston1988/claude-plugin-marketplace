// Dependency gate for queued pipeline rows. Extracted from index.mjs so it can
// be imported by tests without triggering index.mjs's top-level orchestrator IIFE.
import { rowGet } from "../pipeline-db/index.mjs";
import { isPrereqLanded } from "./landed.mjs";
import { detectDefaultBranch } from "../../src/cli/helpers.mjs";

// "proj:feat" → {project:"proj", feature:"feat"}; "bare" → {project:null, feature:"bare"}.
// Split on the FIRST colon (feature slugs never contain colons).
export function parseDepRef(token) {
  const i = token.indexOf(":");
  if (i === -1) return { project: null, feature: token };
  return { project: token.slice(0, i), feature: token.slice(i + 1) };
}

export function depsMet(row, allRows, logFn, projectRoot, db) {
  const feature = row.feature || "?";

  // depends_on — soft list gate: every named prerequisite row must be `done`.
  // A `project:feature` entry is resolved cross-project against the unified DB;
  // a bare entry resolves against this project's rows (allRows).
  const dependsOn = (row.depends_on || "").trim();
  if (dependsOn) {
    const depSlugs = dependsOn.split(",").map(s => s.trim()).filter(Boolean);
    const doneFeatures = new Set(allRows.filter(r => r.stage === "done").map(r => r.feature));
    const unmet = depSlugs.filter(d => {
      const { project, feature: depFeature } = parseDepRef(d);
      if (project) {
        let prereq = null;
        try { prereq = rowGet(db, project, depFeature); } catch {}
        return !(prereq && prereq.stage === "done");
      }
      return !doneFeatures.has(depFeature);
    });
    if (unmet.length) {
      logFn(`  [${feature}] deps not yet done: ${unmet.join(", ")} — holding`);
      return false;
    }
  }

  // waits_on — strict single-prerequisite chain gate: the prerequisite row must
  // be `done` AND its branch must actually be an ancestor of this row's target
  // branch. `done` alone is not enough — a squash-merge on the remote can mark
  // the prereq done before the commit is reachable from the local target, and
  // base-branch chaining must not start a dependent off a base that lacks the
  // prereq's code. The ancestor check closes that race. waits_on is same-project
  // only — its ancestor check is meaningful only within one git repo.
  const waitsOn = (row.waits_on || "").trim();
  if (waitsOn) {
    if (waitsOn.includes(":")) {
      logFn(`  [${feature}] waits_on '${waitsOn}' is cross-project — unsupported, holding`);
      return false;
    }
    const prereq = allRows.find(r => r.feature === waitsOn);
    if (!prereq || prereq.stage !== "done") {
      logFn(`  [${feature}] waits_on '${waitsOn}' not done — holding`);
      return false;
    }
    if (projectRoot) {
      const prereqBranch = (prereq.branch && prereq.branch !== "—") ? prereq.branch : `autonomous/${waitsOn}`;
      const targetBranch = row.target_branch || detectDefaultBranch(projectRoot);
      const { landed, signal } = isPrereqLanded(prereqBranch, targetBranch, projectRoot);
      if (!landed) {
        logFn(`  [${feature}] waits_on '${waitsOn}' done but ${prereqBranch} not yet on ${targetBranch} — holding [signal:${signal}]`);
        return false;
      }
      logFn(`  [${feature}] waits_on '${waitsOn}' landed via ${signal}`);
    }
  }

  return true;
}
