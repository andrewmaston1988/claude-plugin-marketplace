// Helper seams: the root-containment predicate, the project-guard lookup and the
// write-tool classifier the tree derivation rests on.
import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import { join, sep, basename } from "node:path";
import { tmpdir } from "node:os";
import { isUnderRoot, hasWriteTools, guardFor } from "../src/manifest.mjs";

// ── helpers ───────────────────────────────────────────────────────────────────

test("isUnderRoot: boundary-aware, separator-tolerant", () => {
  const root = join(tmpdir(), "rootdir");
  equal(isUnderRoot(join(root, "sub"), root), true);
  equal(isUnderRoot(root, root), true);
  equal(isUnderRoot(root + "extra", root), false);
  equal(isUnderRoot(root.replaceAll(sep, "/") + "/sub", root), true);
});

// io.repoToplevel stub: pretends `cwd` sits inside a repo whose root is `top`,
// or returns null (git failed) so guardFor falls back to basename(cwd).
function ioWithToplevel(top) {
  return { repoToplevel: () => top };
}
const ioNoGit = { repoToplevel: () => null };

test("guardFor: no projects -> undefined; matching repo name -> its command; unknown name -> undefined; Windows case-insensitive", () => {
  const repo = join(tmpdir(), "myrepo");
  const nested = join(repo, "sub");
  const elsewhere = join(tmpdir(), "elsewhere");
  equal(guardFor(repo, {}, ioNoGit), undefined);
  equal(guardFor(repo, { projects: [] }, ioNoGit), undefined);
  equal(guardFor(elsewhere, { projects: [{ name: "myrepo", hooks: { preToolUse: "cmd-a" } }] }, ioNoGit), undefined);
  // io.repoToplevel resolves the leaf's repo root; the project name matches its basename
  deepEqual(
    guardFor(nested, { projects: [{ name: "myrepo", hooks: { preToolUse: "cmd-a" } }] }, ioWithToplevel(repo)),
    { name: "myrepo", command: "cmd-a" },
  );
  // git fails -> falls back to the basename of originalCwd itself
  deepEqual(
    guardFor(repo, { projects: [{ name: "myrepo", hooks: { preToolUse: "cmd-a" } }] }, ioNoGit),
    { name: "myrepo", command: "cmd-a" },
  );
  // a project with no preToolUse yields no guard
  equal(
    guardFor(repo, { projects: [{ name: "myrepo", hooks: {} }] }, ioNoGit),
    undefined,
  );
  if (process.platform === "win32") {
    deepEqual(
      guardFor(join(tmpdir(), "MYREPO"), { projects: [{ name: "myrepo", hooks: { preToolUse: "cmd-a" } }] }, ioNoGit),
      { name: "myrepo", command: "cmd-a" },
    );
  }
});

test("hasWriteTools detects each write tool, case-insensitive", () => {
  equal(hasWriteTools("Read,Grep"), false);
  equal(hasWriteTools("Read,Edit"), true);
  equal(hasWriteTools("write"), true);
  equal(hasWriteTools("Bash"), true);
  equal(hasWriteTools("NotebookEdit"), true);
  equal(hasWriteTools(undefined), false);
});
