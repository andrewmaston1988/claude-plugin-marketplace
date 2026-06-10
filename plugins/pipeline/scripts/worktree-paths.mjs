import { dirname, basename } from "node:path";
import { loadPipelineConfig } from "../src/pipeline-config.mjs";
import { PIPELINE_DEFAULTS } from "../src/config-defaults.mjs";

// Two resolvers share one substitution helper and one config loader. They
// model two distinct contracts:
//
//   orchestratorWorktreePath — one worktree per pipeline-row branch. All
//     session types (dev/research/review/test) sharing the row's branch
//     resolve to the *same* worktree (git semantics: one branch ↔ one
//     worktree). Configurable via `orchestrator_worktree_base`.
//
//   handlerWorktreePath — operator-managed worktrees the plugin reads from
//     but doesn't create. Two kinds today: `qa-test` (where the test-complete
//     CLI commits test reports) and `code-review` (where review-complete
//     commits review verdicts). Configurable via `handler_worktree_base`.
//
// Both templates support a small placeholder vocabulary; the resolvers each
// document which subset they expose.

const DEFAULT_ORCHESTRATOR_TEMPLATE = "{root_parent}/{project}-wt/{branch_type}-{branch_local}";
const DEFAULT_HANDLER_TEMPLATE      = "{root_parent}/.worktrees/{kind}-{feature}";


// "autonomous/foo-bar" → "foo-bar"; "interactive/x" → "x"; "bare" → "bare".
// Used so worktree leaf directories aren't prefixed with the branch's category.
export function branchLocal(branch) {
  const s = branch || "";
  return s.includes("/") ? s.split("/").slice(1).join("/") : s;
}

// "autonomous/foo" → "autonomous"; "research/x" → "research"; "bare" → "".
// Lets the orchestrator template encode session-type info in the path so
// `autonomous/foo` and `research/foo` resolve to distinct worktrees and
// sessions.mjs's path-based classifier can read the type back out.
export function branchType(branch) {
  const s = branch || "";
  return s.includes("/") ? s.split("/")[0] : "";
}

// Substitute {placeholder} tokens in a template. Unknown placeholders are
// left untouched; null/undefined values render as empty strings.
export function substitute(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, v == null ? "" : String(v));
  }
  return out;
}

// Resolve the worktree path the orchestrator creates for a pipeline row.
// `_config` is an injection point for tests; production callers omit it.
export function orchestratorWorktreePath({ project, projectRoot, branch, _config } = {}) {
  const cfg = _config ?? loadPipelineConfig();
  const template = cfg.orchestrator_worktree_base || DEFAULT_ORCHESTRATOR_TEMPLATE;
  return substitute(template, {
    root:         projectRoot || "",
    root_parent:  projectRoot ? dirname(projectRoot) : "",
    project:      project     || (projectRoot ? basename(projectRoot) : ""),
    branch_local: branchLocal(branch),
    branch_type:  branchType(branch),
    branch:       branch || "",
  });
}

// Resolve a handler-style worktree path (qa-test / code-review).
// `_config` is an injection point for tests; production callers omit it.
export function handlerWorktreePath({ project, projectRoot, kind, feature, _config } = {}) {
  const cfg = _config ?? loadPipelineConfig();
  const template = cfg.handler_worktree_base || DEFAULT_HANDLER_TEMPLATE;
  return substitute(template, {
    root:        projectRoot || "",
    root_parent: projectRoot ? dirname(projectRoot) : "",
    project:     project     || (projectRoot ? basename(projectRoot) : ""),
    kind:        kind        || "",
    feature:     feature     || "",
  });
}

// Single source of truth for review-report and test-report locations.
// Returns { wt, dir, glob }. Templates / session-gen / reaper all call this.
// retryN narrows the code-review glob to a specific cycle; null matches all.
export function reportPath({ kind, feature, projectRoot, project, retryN, _config } = {}) {
  if (kind !== "code-review" && kind !== "qa-test") {
    throw new Error(`reportPath: unknown kind '${kind}' (expected "code-review" or "qa-test")`);
  }
  const cfg = _config ?? loadPipelineConfig();
  const wt = handlerWorktreePath({ project, projectRoot, kind, feature, _config: cfg });
  const projectName = project || (projectRoot ? basename(projectRoot) : "");
  const subpathTemplate = cfg.report_subpath?.[kind] ?? PIPELINE_DEFAULTS.report_subpath[kind];
  const sub = substitute(subpathTemplate, { project: projectName, feature: feature || "" });
  // Forward-slash join: handlerWorktreePath already emits forward slashes.
  const dir = `${wt}/${sub}`.replace(/\\/g, "/");
  const featureEsc = String(feature || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const glob = kind === "code-review"
    ? new RegExp(
        retryN == null
          ? `^review-report-.*${featureEsc}.*\\.md$`
          : `^review-report-.*${featureEsc}.*retry${retryN}.*\\.md$`,
      )
    : new RegExp(`^test-report-.*${featureEsc}.*\\.md$`);
  return { wt, dir, glob };
}
