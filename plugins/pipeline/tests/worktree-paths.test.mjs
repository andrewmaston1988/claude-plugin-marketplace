// unified worktree path resolution.
//
// Verifies both resolvers and their substitution helpers under defaults,
// operator-style overrides, and edge cases (null projectRoot, bare branches,
// shared-worktree semantics for orchestrator-spawned sessions).
import { test } from "node:test";
import { equal, deepEqual, throws, ok } from "node:assert/strict";
import { homedir } from "node:os";
import {
  branchLocal,
  branchType,
  substitute,
  featureWorktreePath,
  orchestratorWorktreePath,
  handlerWorktreePath,
  reportPath,
} from "../scripts/worktree-paths.mjs";

// ── branchLocal / branchType helpers ─────────────────────────────────────────

test("branchLocal: slashed branch strips first segment", () => {
  equal(branchLocal("autonomous/foo-bar"), "foo-bar");
  equal(branchLocal("interactive/x"),      "x");
  equal(branchLocal("feat/x/y"),           "x/y");
});

test("branchLocal: bare branch returned as-is", () => {
  equal(branchLocal("main"), "main");
  equal(branchLocal(""),     "");
});

test("branchType: slashed branch returns first segment", () => {
  equal(branchType("autonomous/foo"), "autonomous");
  equal(branchType("research/x"),     "research");
  equal(branchType("tests/y"),        "tests");
});

test("branchType: bare branch returns empty", () => {
  equal(branchType("main"), "");
  equal(branchType(""),     "");
});

// ── substitute ──────────────────────────────────────────────────────────────

test("substitute: known placeholders replaced; literal text preserved", () => {
  const out = substitute("/a/{x}/b/{y}/c", { x: "X1", y: "Y2" });
  equal(out, "/a/X1/b/Y2/c");
});

test("substitute: unknown placeholders left untouched", () => {
  const out = substitute("{a}/{b}", { a: "A" });
  equal(out, "A/{b}");
});

test("substitute: null/undefined render as empty strings", () => {
  equal(substitute("{a}-{b}-{c}", { a: null, b: undefined, c: 0 }), "--0");
});

// ── orchestratorWorktreePath ─────────────────────────────────────────────────

test("orchestratorWorktreePath: default template embeds branch_type and branch_local", () => {
  const out = orchestratorWorktreePath({
    project:     "torrent-hub",
    projectRoot: "/c/code/torrent-hub",
    branch:      "autonomous/feat-x",
    _config:     {},
  });
  // Default: {root_parent}/{project}-wt/{branch_type}-{branch_local}
  equal(out, "/c/code/torrent-hub-wt/autonomous-feat-x");
});

test("orchestratorWorktreePath: distinct branches with same local name get distinct paths", () => {
  const auto = orchestratorWorktreePath({
    project:     "p", projectRoot: "/x/p",
    branch: "autonomous/foo", _config: {},
  });
  const research = orchestratorWorktreePath({
    project:     "p", projectRoot: "/x/p",
    branch: "research/foo", _config: {},
  });
  // {branch_type}-{branch_local} distinguishes them — bug-fix vs initial plan
  equal(auto,     "/x/p-wt/autonomous-foo");
  equal(research, "/x/p-wt/research-foo");
});

test("orchestratorWorktreePath: operator override template", () => {
  const out = orchestratorWorktreePath({
    project:     "torrent-hub",
    projectRoot: "/c/code/torrent-hub",
    branch:      "autonomous/feat-x",
    _config:     { orchestrator_worktree_base: "{root_parent}/wt/{project}/{branch_local}" },
  });
  equal(out, "/c/code/wt/torrent-hub/feat-x");
});

test("orchestratorWorktreePath: null projectRoot renders empty {root} and {root_parent}", () => {
  const out = orchestratorWorktreePath({
    project: "", projectRoot: null, branch: "autonomous/foo", _config: {},
  });
  // Default template: "{root_parent}/{project}-wt/{branch_type}-{branch_local}"
  // With empty values: "/-wt/autonomous-foo"
  equal(out, "/-wt/autonomous-foo");
});

test("orchestratorWorktreePath: project falls back to basename(projectRoot)", () => {
  const out = orchestratorWorktreePath({
    project:     undefined,
    projectRoot: "/a/b/myproj",
    branch:      "autonomous/x",
    _config:     {},
  });
  equal(out, "/a/b/myproj-wt/autonomous-x");
});

// ── handlerWorktreePath ──────────────────────────────────────────────────────

test("handlerWorktreePath: default template for qa-test", () => {
  const out = handlerWorktreePath({
    project: "p", projectRoot: "/c/code/p",
    kind: "qa-test", feature: "feat-x", _config: {},
  });
  equal(out, "/c/code/.worktrees/qa-test-feat-x");
});

test("handlerWorktreePath: default template for code-review", () => {
  const out = handlerWorktreePath({
    project: "p", projectRoot: "/c/code/p",
    kind: "code-review", feature: "feat-x", _config: {},
  });
  equal(out, "/c/code/.worktrees/code-review-feat-x");
});

test("handlerWorktreePath: absolute-path override ignores {root_parent}", () => {
  const out = handlerWorktreePath({
    project: "p", projectRoot: "/anything",
    kind: "qa-test", feature: "x",
    _config: { handler_worktree_base: "/Users/me/wt/{kind}-{feature}" },
  });
  equal(out, "/Users/me/wt/qa-test-x");
});

test("handlerWorktreePath: empty projectRoot renders empty root_parent", () => {
  const out = handlerWorktreePath({
    project: "", projectRoot: null,
    kind: "qa-test", feature: "x", _config: {},
  });
  equal(out, "/.worktrees/qa-test-x");
});

// ── Shared-worktree semantics ────────────────────────────────────────────────

test("all 4 session types on the same branch resolve to the same orchestrator worktree", () => {
  // The orchestrator creates one worktree per branch (git semantics). Dev,
  // research, review, and test sessions on the same branch all use the same
  // worktree by construction — there is no `kind` parameter on the
  // orchestrator resolver.
  const branch = "autonomous/feat-y";
  const args   = { project: "p", projectRoot: "/x/p", branch, _config: {} };
  const path = orchestratorWorktreePath(args);
  // Calling four times with no kind distinction returns the same path.
  for (let i = 0; i < 4; i++) {
    equal(orchestratorWorktreePath(args), path);
  }
});

// ── reportPath ───────────────────────────────────────────────────────────────

test("reportPath: code-review default dir nests under feature worktree (phase 3b)", () => {
  const { wt, dir } = reportPath({
    kind: "code-review", project: "p", projectRoot: "/x/p", feature: "feat-y", _config: {},
  });
  equal(wt,  "/x/.worktrees/p/feat-y");
  equal(dir, "/x/.worktrees/p/feat-y/reports");
});

test("reportPath: qa-test default dir uses test-reports subpath (phase 3b)", () => {
  const { dir } = reportPath({
    kind: "qa-test", project: "p", projectRoot: "/x/p", feature: "feat-y", _config: {},
  });
  equal(dir, "/x/.worktrees/p/feat-y/test-reports");
});

test("reportPath: cfg.report_subpath override is honoured per-kind", () => {
  const cfg = { report_subpath: { "code-review": "custom/{project}/cr", "qa-test": "custom/{project}/qa" } };
  const cr = reportPath({ kind: "code-review", project: "p", projectRoot: "/x/p", feature: "f", _config: cfg });
  const qa = reportPath({ kind: "qa-test",     project: "p", projectRoot: "/x/p", feature: "f", _config: cfg });
  equal(cr.dir, "/x/.worktrees/p/f/custom/p/cr");
  equal(qa.dir, "/x/.worktrees/p/f/custom/p/qa");
});

test("reportPath: worktree_base override flows through to wt + dir", () => {
  const cfg = { worktree_base: "{root_parent}/CLAUDE-wt/{project}/{feature}" };
  const { wt, dir } = reportPath({
    kind: "code-review", project: "p", projectRoot: "/x/p", feature: "f", _config: cfg,
  });
  equal(wt,  "/x/CLAUDE-wt/p/f");
  equal(dir, "/x/CLAUDE-wt/p/f/reports");
});

test("reportPath: project name derives from projectRoot when omitted", () => {
  const { dir } = reportPath({
    kind: "code-review", projectRoot: "/x/myproj", feature: "f", _config: {},
  });
  equal(dir, "/x/.worktrees/myproj/f/reports");
});

test("reportPath: glob matches retry-N report when retryN given", () => {
  const { glob } = reportPath({
    kind: "code-review", project: "p", projectRoot: "/x/p", feature: "feat-y", retryN: 2, _config: {},
  });
  ok(glob.test("review-report-2026-06-10-feat-y-retry2-corr123.md"));
  equal(false, glob.test("review-report-2026-06-10-feat-y-retry0-corr123.md"));
  equal(false, glob.test("review-report-2026-06-10-feat-y-retry1-corr123.md"));
});

test("reportPath: glob matches across retries when retryN null", () => {
  const { glob } = reportPath({
    kind: "code-review", project: "p", projectRoot: "/x/p", feature: "feat-y", _config: {},
  });
  ok(glob.test("review-report-2026-06-10-feat-y-retry0-corr.md"));
  ok(glob.test("review-report-2026-06-10-feat-y-retry5-corr.md"));
});

test("reportPath: qa-test glob matches test-report filename pattern", () => {
  const { glob } = reportPath({
    kind: "qa-test", project: "p", projectRoot: "/x/p", feature: "feat-y", _config: {},
  });
  ok(glob.test("test-report-2026-06-10-feat-y-corr.md"));
  equal(false, glob.test("review-report-2026-06-10-feat-y-corr.md"));
});

test("reportPath: feature with regex metachars is escaped in glob", () => {
  const { glob } = reportPath({
    kind: "code-review", project: "p", projectRoot: "/x/p", feature: "feat.x+y", retryN: 0, _config: {},
  });
  ok(glob.test("review-report-2026-06-10-feat.x+y-retry0-corr.md"));
  // The literal-dot escape means an *unrelated* feature like 'featXxXy' must not match.
  equal(false, glob.test("review-report-2026-06-10-featXxXy-retry0-corr.md"));
});

// ── featureWorktreePath ──────────────────────────────────────────────────────

test("featureWorktreePath: default template is per-feature (phase 3b)", () => {
  const out = featureWorktreePath({
    project: "p", projectRoot: "/x/p", feature: "feat-y", _config: {},
  });
  equal(out, "/x/.worktrees/p/feat-y");
});

test("featureWorktreePath: operator override with {feature}", () => {
  const out = featureWorktreePath({
    project: "p", projectRoot: "/x/p", feature: "feat-y",
    _config: { worktree_base: "{root_parent}/.worktrees/{project}/{feature}" },
  });
  equal(out, "/x/.worktrees/p/feat-y");
});

test("featureWorktreePath: ~/ expands to homedir", () => {
  const out = featureWorktreePath({
    project: "p", projectRoot: "/x/p", feature: "f",
    _config: { worktree_base: "~/wt/{project}/{feature}" },
  });
  equal(out, `${homedir()}/wt/p/f`);
});

test("featureWorktreePath: absolute POSIX template passes through verbatim", () => {
  const out = featureWorktreePath({
    project: "p", projectRoot: "/x/p", feature: "f",
    _config: { worktree_base: "/srv/wt/{feature}" },
  });
  equal(out, "/srv/wt/f");
});

test("featureWorktreePath: Windows drive-letter template passes through verbatim", () => {
  const out = featureWorktreePath({
    project: "p", projectRoot: "/x/p", feature: "f",
    _config: { worktree_base: "C:/work/wt/{feature}" },
  });
  equal(out, "C:/work/wt/f");
});

test("featureWorktreePath: UNC template passes through verbatim", () => {
  const out = featureWorktreePath({
    project: "p", projectRoot: "/x/p", feature: "f",
    _config: { worktree_base: "//server/share/wt/{feature}" },
  });
  equal(out, "//server/share/wt/f");
});

test("featureWorktreePath: relative template resolves against projectRoot", () => {
  const out = featureWorktreePath({
    project: "p", projectRoot: "/x/p", feature: "f",
    _config: { worktree_base: "wt/{feature}" },
  });
  // Host's path.resolve joins relative segments to projectRoot; on Windows the
  // result is drive-anchored. Assert the tail rather than the absolute prefix.
  ok(out.replace(/\\/g, "/").endsWith("/x/p/wt/f"));
});

test("featureWorktreePath: unknown placeholder passes through literally", () => {
  const out = featureWorktreePath({
    project: "p", projectRoot: "/x/p", feature: "f",
    _config: { worktree_base: "/wt/{feature}/{unknown}" },
  });
  equal(out, "/wt/f/{unknown}");
});

// ── Parity: compat wrappers vs pre-refactor outputs ──────────────────────────
//
// Pre-refactor implementations called `substitute()` directly with no
// resolveBase / `~/` handling. For the default templates plus the operator
// overrides exercised below, the substituted output is already absolute, so
// resolveTemplate's classification step leaves it untouched. These tests pin
// that equivalence.

function _preRefactorOrchestrator({ project, projectRoot, branch, _config }) {
  const cfg = _config ?? {};
  const template = cfg.orchestrator_worktree_base || "{root_parent}/{project}-wt/{branch_type}-{branch_local}";
  return substitute(template, {
    root:         projectRoot || "",
    root_parent:  projectRoot ? projectRoot.replace(/\/[^/]+$/, "") : "",
    project:      project     || (projectRoot ? projectRoot.split("/").pop() : ""),
    branch_local: branchLocal(branch),
    branch_type:  branchType(branch),
    branch:       branch || "",
  });
}

function _preRefactorHandler({ project, projectRoot, kind, feature, _config }) {
  const cfg = _config ?? {};
  const template = cfg.handler_worktree_base || "{root_parent}/.worktrees/{kind}-{feature}";
  return substitute(template, {
    root:        projectRoot || "",
    root_parent: projectRoot ? projectRoot.replace(/\/[^/]+$/, "") : "",
    project:     project     || (projectRoot ? projectRoot.split("/").pop() : ""),
    kind:        kind        || "",
    feature:     feature     || "",
  });
}

const ORCH_CASES = [
  { project: "p",  projectRoot: "/x/p",  branch: "autonomous/foo",      _config: {} },
  { project: "p",  projectRoot: "/x/p",  branch: "research/foo",        _config: {} },
  { project: "p",  projectRoot: "/x/p",  branch: "main",                _config: {} },
  { project: "p",  projectRoot: null,    branch: "autonomous/foo",      _config: {} },
  { project: undefined, projectRoot: "/a/b/myproj", branch: "autonomous/x", _config: {} },
  { project: "p",  projectRoot: "/c/code/p", branch: "autonomous/feat-x",
    _config: { orchestrator_worktree_base: "{root_parent}/wt/{project}/{branch_local}" } },
];

for (const c of ORCH_CASES) {
  test(`parity orchestrator: ${JSON.stringify({ branch: c.branch, cfg: c._config })}`, () => {
    equal(orchestratorWorktreePath(c), _preRefactorOrchestrator(c));
  });
}

const HANDLER_CASES = [
  { project: "p", projectRoot: "/c/code/p", kind: "qa-test",     feature: "feat-x", _config: {} },
  { project: "p", projectRoot: "/c/code/p", kind: "code-review", feature: "feat-x", _config: {} },
  { project: "p", projectRoot: null,        kind: "qa-test",     feature: "x",      _config: {} },
  { project: "p", projectRoot: "/anything", kind: "qa-test",     feature: "x",
    _config: { handler_worktree_base: "/Users/me/wt/{kind}-{feature}" } },
];

for (const c of HANDLER_CASES) {
  test(`parity handler: ${JSON.stringify({ kind: c.kind, cfg: c._config })}`, () => {
    equal(handlerWorktreePath(c), _preRefactorHandler(c));
  });
}

test("reportPath: unknown kind throws", () => {
  throws(() => reportPath({ kind: "bogus", project: "p", projectRoot: "/x/p", feature: "f", _config: {} }),
         /unknown kind 'bogus'/);
});
