// Derived per-task policy: which tree a task lives in, what its tools let it do,
// and the roots its write guard is confined to. Pure questions about an already
// parsed task — nothing here validates an authored manifest.

import { resolve, join } from "node:path";

// Default leaf toolset is read-only; write capability must be asked for.
export const DEFAULT_TOOLS = "Read,Grep,Glob";
const WRITE_TOOLS = new Set(["edit", "write", "bash", "notebookedit"]);

export function hasWriteTools(allowedTools) {
  return String(allowedTools || "")
    .split(",")
    .map((t) => t.trim().toLowerCase().replace(/\(.*\)$/, ""))
    .filter(Boolean)
    .some((t) => WRITE_TOOLS.has(t));
}

// THE rule for which tree a task lives in, and the only one: a leaf that can write
// gets a tree — the one its `workspace` names, else its own id — and a leaf that
// cannot gets none, because it reads the live repo. Normalized tasks carry the
// answer; raw ones (hand-built plans, pre-normalization validation) derive it here.
//
// There is deliberately no second path for an explicitly-spelled tree. The previous
// grammar had one, and the two disagreed on three derived fields for months.
export function resolveWorktreeName(t) {
  if (t.worktreeName !== undefined) return t.worktreeName;
  if (t.compute !== undefined || t.integrate !== undefined || t.manifest !== undefined) return undefined;
  // The engine's own digest node is not a repo leaf: a report digest holds Write so it would
  // otherwise derive a tree, and its cwd is a scratch dir outside every tree by design.
  if (t.isDigest) return undefined;
  if (!hasWriteTools(t.allowedTools)) return undefined;
  return t.workspace ?? t.id;
}

// ── the leaf write guard's roots ──────────────────────────────────────────────
// The tree the scheduler will create for this writer. The formula is
// worktree.mjs's prepareIsolation (`resolve(join(resultsDir, "wt-" + name))`) —
// keep the two in step, or the guard denies every write into the very tree it
// was injected to protect.
function worktreePathFor(worktreeName, resultsDir) {
  return resolve(join(resultsDir, `wt-${worktreeName}`));
}

// A writer's allowed roots: its own tree, plus `outputDir` when set — that one
// resolves against the dispatch cwd, i.e. into the live checkout, so it is a
// second root rather than a directory inside the first.
export function leafWriteGuardRoots({ worktreeName, resultsDir, outputDir }) {
  return [
    ...(typeof worktreeName === "string" && worktreeName ? [worktreePathFor(worktreeName, resultsDir)] : []),
    ...(outputDir ? [outputDir] : []),
  ];
}

// True when this task shares its tree with ordered siblings rather than owning it.
// Sharers run in ONE directory, so they must form a single ordered chain — two
// unordered members would race and corrupt each other.
// Only a named workspace shares; a derived tree is the task's alone by construction.
export function isSharedTree(t) {
  return typeof t.workspace === "string" && !!t.workspace;
}

// The kinds that run in the engine and spawn no leaf. `model` carries a display
// sentinel for a normalized task, but a hand-built plan (tests, runPlan callers)
// may set only the key — so both are checked, in ONE place. Every site that asks
// "does this spend a model call?" must route here: the sites disagreeing is how a
// node gets counted as a leaf in one place and skipped in another, and how a new
// kind gets a dispatch branch everywhere but one.
const AGENTLESS = ["compute", "integrate"];
export function isAgentless(t) {
  return AGENTLESS.some((k) => t?.[k] !== undefined || t?.model === k);
}

// The display-sentinel models normalization stamps on never-dispatched nodes
// (see the note at the normalization site). Single home: every "did a model
// actually run?" check on a RESULT routes through this.
const SENTINEL_MODELS = new Set(["compute", "integrate", "manifest"]);
export function isSentinelModel(model) {
  return SENTINEL_MODELS.has(String(model || ""));
}
