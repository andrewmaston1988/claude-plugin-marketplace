import { dirname, basename, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { loadPipelineConfig } from "../src/pipeline-config.mjs";
import { PIPELINE_DEFAULTS } from "../src/config-defaults.mjs";

// Pinned to the canonical vocabulary by tests; unknown placeholders pass through literally.
export const PLACEHOLDER_KEYS = Object.freeze([
  "root",
  "root_parent",
  "root_grandparent",
  "project",
  "feature",
  "kind",
  "branch",
  "branch_type",
  "branch_local",
  "config_dir",
]);

// Empty/nullish → null (not "") so a missing guard can't route "" into
// path.join and yield a CWD-relative path.
export function resolveTemplate(
  template,
  vars = {},
  { resolveBase, configDir } = {},
) {
  if (template == null || template === "") return null;
  const substituted = substitute(String(template), {
    ...vars,
    config_dir: vars.config_dir ?? configDir ?? "",
  });
  const expanded = _expandTilde(substituted);
  if (_isAbsoluteAny(expanded)) return expanded;
  if (!resolveBase) return expanded;
  return resolve(resolveBase, expanded);
}

// Resolve only the first token of a hook command (the binary/path);
// trailing argv passes through unchanged.
export function resolveHookFirstToken(hookVal, configDir) {
  let raw = null;
  if (!hookVal) return null;
  if (typeof hookVal === "string") raw = hookVal;
  else if (Array.isArray(hookVal) && hookVal[0]?.command) raw = hookVal[0].command;
  if (!raw) return null;
  const m = raw.match(/^(\S+)(\s.*)?$/);
  if (!m) return raw;
  const head = m[1];
  const tail = m[2] || "";
  const looksLikePath = /^~|^[/\\]|^[A-Za-z]:[\\/]|\{(config_dir|root|project)\}/.test(head);
  if (!looksLikePath) return raw;
  return resolveTemplate(head, {}, { resolveBase: configDir, configDir }) + tail;
}

function _expandTilde(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return homedir() + p.slice(1);
  }
  return p;
}

// Cross-platform: node:path.isAbsolute only honours the host's rules.
function _isAbsoluteAny(p) {
  if (!p) return false;
  if (isAbsolute(p)) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith("\\\\") || p.startsWith("//")) return true;
  return false;
}

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
// Phase 3b: one worktree per feature; project-namespaced, branch-agnostic.
const DEFAULT_WORKTREE_TEMPLATE     = "{root_parent}/.worktrees/{project}/{feature}";
const DEFAULT_PUBLISH_BRANCH_TEMPLATE = "{kind}/{feature}";

function _commonVars({ project, projectRoot }) {
  return {
    root:             projectRoot || "",
    root_parent:      projectRoot ? dirname(projectRoot) : "",
    root_grandparent: projectRoot ? dirname(dirname(projectRoot)) : "",
    project:          project || (projectRoot ? basename(projectRoot) : ""),
  };
}


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

// The branch a pipeline row resolves to. A declared `row.branch` is
// authoritative for ANY name; the "—" placeholder and blank fall back to the
// conventional default `autonomous/<plan-stem>`. Single source of truth for
// spawn, session-gen, reaper, and dev-complete so they can't disagree.
export function resolveRowBranch(row, planStem) {
  const declared = String(row?.branch ?? "").trim();
  return (declared && declared !== "—") ? declared : `autonomous/${planStem}`;
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

// Canonical per-feature worktree path. Single template (`cfg.worktree_base`).
// Branch-context placeholders substitute to "" when called without one.
// Phase 3b moves all call sites onto this helper.
export function featureWorktreePath({ project, projectRoot, feature, _config } = {}) {
  const cfg = _config ?? loadPipelineConfig();
  const template = cfg.worktree_base || DEFAULT_WORKTREE_TEMPLATE;
  return resolveTemplate(template, {
    ..._commonVars({ project, projectRoot }),
    feature:      feature || "",
    branch:       "",
    branch_type:  "",
    branch_local: "",
  }, { resolveBase: projectRoot });
}

// Deprecated compat wrapper. Phase 3b: callers should use featureWorktreePath.
// Emits a one-shot console.warn so leftover call sites are visible during the
// transition. Suppressed when invoked from worktree-paths tests (NODE_ENV=test
// + PIPELINE_SUPPRESS_DEPRECATED) so the test suite stays quiet.
let _orchWarned = false;
export function orchestratorWorktreePath({ project, projectRoot, branch, _config } = {}) {
  if (!_orchWarned && !process.env.PIPELINE_SUPPRESS_DEPRECATED) {
    console.warn("[deprecation] orchestratorWorktreePath is deprecated — use featureWorktreePath (phase 3b)");
    _orchWarned = true;
  }
  const cfg = _config ?? loadPipelineConfig();
  const template = cfg.orchestrator_worktree_base || DEFAULT_ORCHESTRATOR_TEMPLATE;
  return resolveTemplate(template, {
    ..._commonVars({ project, projectRoot }),
    branch_local: branchLocal(branch),
    branch_type:  branchType(branch),
    branch:       branch || "",
  }, { resolveBase: projectRoot });
}

// Deprecated compat wrapper. Phase 3b: callers should use featureWorktreePath.
let _handlerWarned = false;
export function handlerWorktreePath({ project, projectRoot, kind, feature, _config } = {}) {
  if (!_handlerWarned && !process.env.PIPELINE_SUPPRESS_DEPRECATED) {
    console.warn("[deprecation] handlerWorktreePath is deprecated — use featureWorktreePath (phase 3b)");
    _handlerWarned = true;
  }
  const cfg = _config ?? loadPipelineConfig();
  const template = cfg.handler_worktree_base || DEFAULT_HANDLER_TEMPLATE;
  return resolveTemplate(template, {
    ..._commonVars({ project, projectRoot }),
    kind:    kind    || "",
    feature: feature || "",
  }, { resolveBase: projectRoot });
}

// Single source of truth for review-report and test-report locations.
// Returns { wt, dir, glob, publishBranch }. Templates / session-gen / reaper all call this.
// retryN narrows the code-review glob to a specific cycle; null matches all.
// Phase 3b: reports live under the single feature worktree (featureWorktreePath);
// `publishBranch` is the side-branch the stash-switchback dance commits the report to.
export function reportPath({ kind, feature, projectRoot, project, retryN, _config } = {}) {
  if (kind !== "code-review" && kind !== "qa-test") {
    throw new Error(`reportPath: unknown kind '${kind}' (expected "code-review" or "qa-test")`);
  }
  const cfg = _config ?? loadPipelineConfig();
  const wt = featureWorktreePath({ project, projectRoot, feature, _config: cfg });
  const projectName = project || (projectRoot ? basename(projectRoot) : "");
  const subpathTemplate = cfg.report_subpath?.[kind] ?? PIPELINE_DEFAULTS.report_subpath[kind];
  const sub = substitute(subpathTemplate, { project: projectName, feature: feature || "" });
  // Forward-slash join: featureWorktreePath already emits forward slashes.
  const dir = `${wt}/${sub}`.replace(/\\/g, "/");
  const featureEsc = String(feature || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const glob = kind === "code-review"
    ? new RegExp(
        retryN == null
          ? `^review-report-.*${featureEsc}.*\\.md$`
          : `^review-report-.*${featureEsc}.*retry${retryN}.*\\.md$`,
      )
    : new RegExp(`^test-report-.*${featureEsc}.*\\.md$`);
  const publishBranchTemplate = cfg.report_publish_branch_template || DEFAULT_PUBLISH_BRANCH_TEMPLATE;
  const publishBranch = substitute(publishBranchTemplate, { kind, feature: feature || "" });
  return { wt, dir, glob, publishBranch };
}
