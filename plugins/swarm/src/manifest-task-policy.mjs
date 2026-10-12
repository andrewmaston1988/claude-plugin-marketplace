// Derived per-task policy: which tree a task lives in, what its tools let it do,
// and the roots its write guard is confined to. Pure questions about an already
// parsed task — nothing here validates an authored manifest.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, dirname, relative, isAbsolute, sep } from "node:path";
import { treeDirFor, treeRootFor, listTreeRecords, legacyTreeDirs, runOfTree } from "./worktree.mjs";
import { isUnderRoot } from "./roots.mjs";

// Default leaf toolset is read-only; write capability must be asked for.
export const DEFAULT_TOOLS = "Read,Grep,Glob";
const WRITE_TOOLS = new Set(["edit", "write", "bash", "notebookedit"]);

// Every MCP server configured on the DISPATCHING machine, as an allow rule. Servers
// must be named: `mcp__*` is skipped with a warning, so a wildcard grants nothing.
export function mcpTools(_read = () => readFileSync(join(homedir(), ".claude.json"), "utf8")) {
  try {
    return Object.keys(JSON.parse(_read()).mcpServers || {}).map((s) => `mcp__${s}`);
  } catch { return []; }
}

// Per runner: off bypass permissions an unlisted tool is DENIED, so a claude-CLI leaf keeps Skill and the MCP servers; Codex gets the trio alone.
export function defaultToolsFor(provider, mcp = []) {
  return provider === "codex" ? DEFAULT_TOOLS : [DEFAULT_TOOLS, "Skill", ...mcp].join(",");
}

const toolNames = (allowedTools) => String(allowedTools || "")
  .split(",")
  .map((t) => t.trim().toLowerCase().replace(/\(.*\)$/, ""))
  .filter(Boolean);

export function hasWriteTools(allowedTools) {
  return toolNames(allowedTools).some((t) => WRITE_TOOLS.has(t));
}

// The Claude leaf that authors files, as against one whose Bash only runs checks.
export function holdsEditTools(allowedTools) {
  return toolNames(allowedTools).some((t) => t === "edit" || t === "write" || t === "notebookedit");
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
// Both halves go through worktree.mjs's resolver. A tree path derived HERE is how
// the guard came to name a directory the scheduler never creates, and to deny every
// write into the very tree it was injected to protect.

// Two paths are the same path when each is under the other — roots.mjs's own
// normalisation (separators, win32 case, trailing separator), not string equality.
const samePath = (a, b) => isUnderRoot(a, b) && isUnderRoot(b, a);

// Resolve a recorded task cwd to its tree name; records cover legacy, reconfigured and
// moved trees. forEach clones use their worktreeName, not their task id. Undefined means
// the cwd is outside every tree, such as a live-repo reader or digest scratch.
export function worktreeNameFromCwd(cwd, resultsDir, cfg) {
  if (typeof cwd !== "string" || !cwd) return undefined;
  const p = resolve(cwd);
  const run = resolve(resultsDir);
  // The run's own record first: a legacy tree, a reconfigured `treeRoot` and a tree
  // moved by hand all still name their tree here, and none of them is the formula.
  const recorded = listTreeRecords(run).find((r) => typeof r.path === "string" && samePath(r.path, p));
  if (recorded) return recorded.name;
  const rel = relative(run, p);
  // `..`, and an absolute rel on win32 (a cross-drive relative), both mean "not inside".
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
    // A pre-upgrade run has no records: its tree IS the run dir's child, <run>/wt-<name>.
    // The prefix rule stays where it belongs — legacyTreeDirs strips it, so a nested
    // cwd (the leaf's declared depth) resolves through its first segment either way.
    const [first] = rel.split(sep);
    const legacy = legacyTreeDirs(run).find((t) => samePath(join(run, first), t.path));
    return legacy ? legacy.name : undefined;
  }
  // The formula, for a tree whose record is gone: <treeRoot>/<project>/<run>/<name>.
  // Read from the same three leading segments runOfTree inverts, and checked against
  // THIS run — a sibling run's tree is not this leaf's.
  const root = treeRootFor(cfg);
  if (!isUnderRoot(p, root)) return undefined;
  const parts = relative(root, p).split(sep);
  if (parts.length < 3) return undefined;
  // runOfTree inverts the SAME two-level tail from the runs root this run dir sits in.
  const runsRoot = dirname(dirname(run));
  return samePath(runOfTree(join(root, ...parts.slice(0, 3)), cfg, { runsRoot }), run)
    ? parts[2]
    : undefined;
}

// A writer's allowed roots: its own tree, plus `outputDir` when set — that one
// resolves against the dispatch cwd, i.e. into the live checkout, so it is a
// second root rather than a directory inside the first.
export function leafWriteGuardRoots({ worktreeName, resultsDir, outputDir, cfg }) {
  return [
    ...(typeof worktreeName === "string" && worktreeName ? [treeDirFor(resultsDir, worktreeName, cfg)] : []),
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
