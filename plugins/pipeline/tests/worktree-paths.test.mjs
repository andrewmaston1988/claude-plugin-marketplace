// smoke-11: unified worktree path resolution.
//
// Verifies both resolvers and their substitution helpers under defaults,
// operator-style overrides, and edge cases (null projectRoot, bare branches,
// shared-worktree semantics for orchestrator-spawned sessions).
import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import {
  branchLocal,
  branchType,
  substitute,
  orchestratorWorktreePath,
  handlerWorktreePath,
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
