import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal } from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { initRepo } from "./helpers/worktree-fixtures.mjs";
import { importTouchingCommits, commitPaths } from "./helpers/landed-fixtures.mjs";

function headBlob(repo, path) {
  const r = spawnSync("git", ["show", `HEAD:${path}`], { cwd: repo, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git show HEAD:${path} failed: ${(r.stderr || "").trim()}`);
  return r.stdout;
}

// fast-import leaves the index and worktree on the pre-import commit, so this row
// is what stops a later commit from staging that old content back in.
test("a commit after importTouchingCommits keeps the imported content at HEAD", () => {
  const repo = initRepo();
  try {
    importTouchingCommits(repo, { path: "a.txt", count: 3 });
    commitPaths(repo, ["b.txt"], "another file");
    equal(headBlob(repo, "a.txt"), "later 2\n", "the later commit reverted the imported history");
    equal(readFileSync(join(repo, "a.txt"), "utf8"), "later 2\n", "the worktree still holds pre-import content");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
