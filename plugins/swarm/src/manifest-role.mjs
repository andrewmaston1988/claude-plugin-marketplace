// A task's declared intent. `role: "verifier"` is the one role validate enforces:
// a verifier reports, so it holds no edit tool and never names a tree a writer uses —
// its own tree, seeded by an agentless integrate node, is the one shape it may name.
// Pure questions over a task list — the caller owns the error and warning channels.

import { holdsEditTools, resolveWorktreeName } from "./manifest-task-policy.mjs";
import { makeReaches } from "./manifest-relations.mjs";

const VERIFIER = "verifier";
const VERIFIER_ID_RE = /^(verify|review|judge)[-_]/;

const defaultLabel = (t) => `task '${t?.id ?? "with missing id"}'`;

// The trees write-tool tasks occupy, derived exactly as the scheduler derives them: a
// writer with no `workspace` still owns `<id>`, so a verifier naming that id names a
// writers' tree. `excludeVerifiers` is the difference between the two callers: a
// verifier holds Bash like a writer but its own seeded tree is not a writers' tree.
const writerWorkspaces = (tasks, excludeVerifiers) => new Set(
  tasks
    .filter((t) => !(excludeVerifiers && t?.role === VERIFIER))
    .map(resolveWorktreeName)
    .filter((n) => typeof n === "string" && n)
);

// The refusals the field carries. Each message names the field the fix touches and
// the shape that replaces it, so one validate round-trip reaches green.
export function roleErrors(tasks, label = defaultLabel) {
  const list = tasks || [];
  const writers = writerWorkspaces(list, true);
  const reaches = makeReaches(list);
  const errors = [];
  for (const t of list) {
    if (t?.role !== VERIFIER) continue;
    const l = label(t);
    if (holdsEditTools(t.allowedTools)) {
      errors.push(
        `${l}: role "verifier" may not hold edit tools — allowedTools is ${JSON.stringify(t.allowedTools)}; a verifier reports and never edits.\n` +
        `    Drop Edit/Write/NotebookEdit. Bash stays allowed: to read the writers' commits, keep it and the verifier runs in its own tree.`);
    }
    const names = typeof t.workspace === "string" && t.workspace ? t.workspace : undefined;
    if (names && writers.has(names)) {
      errors.push(
        `${l}: role "verifier" may not name a writers' tree — "${names}" is named by a task that writes; a verifier runs in its own.\n` +
        `    Give it a private workspace seeded by an integrate node, and list that node in after:\n` +
        `        { "id": "seed-verify-x", "after": ["build"], "integrate": { "into": "verify-x", "from": ["build"] } }\n` +
        `        { "id": "verify-x", "role": "verifier", "allowedTools": "Read,Grep,Glob,Bash", "workspace": "verify-x", "after": ["build", "seed-verify-x"] }`);
    } else if (names) {
      // A seed fills this tree; run before it lands and the verifier reads the pinned
      // base with none of the commits it was told to review.
      const late = list.filter((o) => o?.integrate?.into === names && !reaches(t.id, o.id));
      if (late.length) {
        const ids = late.map((o) => `'${o.id}'`).join(", ");
        errors.push(
          `${l}: tree "${names}" is seeded by ${ids}, which may run after the verifier — both are ready together.\n` +
          `    Add ${ids} to this task's after so the merge lands before the review starts.`);
      }
    }
  }
  return errors;
}

// The incident shape: an id that announces a verifier while the task can still
// write, authored without the field. Bash alone is silent — a reviewer holding git
// in its own tree is the documented phased-chain shape.
export function roleWarnings(tasks, label = defaultLabel) {
  const list = tasks || [];
  const writers = writerWorkspaces(list, false);
  const warnings = [];
  for (const t of list) {
    // The field is the author's answer; its value is the shape gate's business.
    if (t?.role !== undefined) continue;
    if (!VERIFIER_ID_RE.test(String(t?.id || ""))) continue;
    const edits = holdsEditTools(t.allowedTools);
    const shared = typeof t.workspace === "string" && writers.has(t.workspace);
    if (!edits && !shared) continue;
    const why = [
      edits && `can edit (allowedTools ${JSON.stringify(t.allowedTools)})`,
      shared && `names the writers' workspace "${t.workspace}"`,
    ].filter(Boolean).join(" and ");
    warnings.push(
      `${label(t)} looks like a verifier but ${why} — add "role": "verifier" and drop Edit/Write, or rename it if it really writes`);
  }
  return warnings;
}
