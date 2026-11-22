// plan-files.test.mjs — isExternalPath unit tests.
//
// Verifies the external-path skip predicate added to verifyPlanFilesInDiff:
//   - HOME-relative shorthands (~/  $HOME/  ${HOME}/) → external
//   - Absolute path that normalizePlanPath couldn't reduce → external
//   - Relative in-project paths → not external (regression guard)
import "../../../tests/helpers/isolate-home.mjs";
import { test } from "node:test";
import { ok, equal } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step2VerifyDone, isExternalPath } from "./plan-files.mjs";

test("step2 reads the plan in the registered project's feature worktree", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "merge-plan-files-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const projectRoot = join(tmp, "checkout");
  const plansDir = join(tmp, ".worktrees", "registered-project", "feature", "plans");
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(join(plansDir, "feature.md"), "- Run the feature (needs testing)\n");

  const blockers = await step2VerifyDone(null, { "autonomous/feature": null }, projectRoot, "registered-project");

  equal(blockers.length, 1);
  ok(blockers[0].includes("plan has (needs testing) items"));
});

test("isExternalPath: ~/path is external", () => {
  ok(isExternalPath("~/.pipeline/hooks/on-merge.mjs", "~/.pipeline/hooks/on-merge.mjs"));
});

test("isExternalPath: $HOME/path is external", () => {
  ok(isExternalPath("$HOME/.claude/skills/foo/SKILL.md", "$HOME/.claude/skills/foo/SKILL.md"));
});

test("isExternalPath: ${HOME}/path is external", () => {
  ok(isExternalPath("${HOME}/bar.md", "${HOME}/bar.md"));
});

test("isExternalPath: absolute Windows path outside project is external", () => {
  // normalizePlanPath leaves the C:/ prefix intact when the project name is not
  // in the path segments — signal that it resolved outside the project tree.
  const norm = "C:/code/other-repo/scripts/foo.mjs";
  ok(isExternalPath("C:/code/other-repo/scripts/foo.mjs", norm));
});

test("isExternalPath: absolute Unix path outside project is external", () => {
  ok(isExternalPath("/usr/local/share/foo.mjs", "/usr/local/share/foo.mjs"));
});

test("isExternalPath: in-project absolute path (normalized to relative) is not external", () => {
  // normalizePlanPath strips the drive prefix when the project name is in the segments,
  // so the normalized form is relative — not external.
  equal(isExternalPath("C:/code/my-project/src/foo.ts", "src/foo.ts"), false);
});

test("isExternalPath: bare relative path is not external", () => {
  equal(isExternalPath("plugins/pipeline/REFERENCE.md", "plugins/pipeline/REFERENCE.md"), false);
});
