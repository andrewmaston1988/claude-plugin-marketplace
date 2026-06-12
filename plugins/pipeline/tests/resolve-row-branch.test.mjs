import { test } from "node:test";
import { equal } from "node:assert/strict";
import { resolveRowBranch } from "../scripts/worktree-paths.mjs";

test("resolveRowBranch: a declared branch wins (any prefix)", () => {
  equal(resolveRowBranch({ branch: "anm/SYM-8773_tooltips" }, "tooltips"), "anm/SYM-8773_tooltips");
  equal(resolveRowBranch({ branch: "interactive/x" }, "x"), "interactive/x");
});

test("resolveRowBranch: em-dash placeholder falls back to autonomous/<stem>", () => {
  equal(resolveRowBranch({ branch: "—" }, "my-feat"), "autonomous/my-feat");
});

test("resolveRowBranch: missing/blank branch falls back to autonomous/<stem>", () => {
  equal(resolveRowBranch({}, "my-feat"), "autonomous/my-feat");
  equal(resolveRowBranch({ branch: "  " }, "my-feat"), "autonomous/my-feat");
  equal(resolveRowBranch(null, "my-feat"), "autonomous/my-feat");
});
