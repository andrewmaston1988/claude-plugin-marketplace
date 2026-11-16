// A task's declared intent. `role: "verifier"` is the one role validate enforces:
// a verifier reports, so it holds no edit tool and names no tree. Pure questions
// over a task list — the caller owns the error and warning channels.

import { hasWriteTools, holdsEditTools } from "./manifest-task-policy.mjs";

const VERIFIER = "verifier";
const VERIFIER_ID_RE = /^(verify|review|judge)[-_]/;

const defaultLabel = (t) => `task '${t?.id ?? "with missing id"}'`;

// The refusals the field carries. Each message names the field the fix touches and
// the shape that replaces it, so one validate round-trip reaches green.
export function roleErrors(tasks, label = defaultLabel) {
  const errors = [];
  for (const t of tasks || []) {
    if (t?.role !== VERIFIER) continue;
    const l = label(t);
    if (holdsEditTools(t.allowedTools)) {
      errors.push(
        `${l}: role "verifier" may not hold edit tools — allowedTools is ${JSON.stringify(t.allowedTools)}; a verifier reports and never edits.\n` +
        `    Drop Edit/Write/NotebookEdit. Bash stays allowed: to read the writers' commits, keep it and the verifier runs in its own tree.`);
    }
    if (t.workspace !== undefined) {
      errors.push(
        `${l}: role "verifier" may not name a workspace — "${t.workspace}" is a tree the writers share; a verifier runs in its own.\n` +
        `    Drop "workspace". A Bash-holding verifier still gets a private tree; seed it from the writers' branch with an integrate node if it must see their commits.`);
    }
  }
  return errors;
}

// The incident shape: an id that announces a verifier while the task can still
// write, authored without the field. Bash alone is silent — a reviewer holding git
// in its own tree is the documented phased-chain shape.
export function roleWarnings(tasks, label = defaultLabel) {
  const list = tasks || [];
  const writerWorkspaces = new Set(
    list
      .filter((t) => hasWriteTools(t?.allowedTools) && typeof t.workspace === "string" && t.workspace)
      .map((t) => t.workspace)
  );
  const warnings = [];
  for (const t of list) {
    // The field is the author's answer; its value is the shape gate's business.
    if (t?.role !== undefined) continue;
    if (!VERIFIER_ID_RE.test(String(t?.id || ""))) continue;
    const edits = holdsEditTools(t.allowedTools);
    const shared = typeof t.workspace === "string" && writerWorkspaces.has(t.workspace);
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
