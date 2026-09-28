// Helper seams: the root-containment predicate, the project-guard lookup and the
// write-tool classifier the tree derivation rests on.
import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import { join, sep, basename } from "node:path";
import { tmpdir } from "node:os";
import { isUnderRoot, hasWriteTools, guardFor } from "../src/manifest.mjs";
import { builtinToolNames, BUILTIN_TOOLS } from "../src/manifest-task-policy.mjs";
import { codexSandbox } from "../src/codex.mjs";

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

// PowerShell runs arbitrary commands exactly as Bash does, so it is a write tool:
// a Read,PowerShell leaf that shared the read-only snapshot could write into it.
test("PowerShell is a write tool", () => {
  equal(hasWriteTools("Read,PowerShell"), true);
});

// The CLI matches --tools names EXACTLY, so a lowercase name silently removes the
// tool. One table canonicalises every name the manifest may use.
test("builtinToolNames returns the CLI's own spelling, dropping what it cannot name", () => {
  deepEqual(builtinToolNames("write"), ["Write"]);
  deepEqual(builtinToolNames("read,Bash(git:*),mcp__scout__search"), ["Read", "Bash"]);
  deepEqual(builtinToolNames("PowerShell,LSP,NotebookEdit,WebFetch"), ["PowerShell", "LSP", "NotebookEdit", "WebFetch"]);
  deepEqual(builtinToolNames("mcp__scout__search"), []);
  deepEqual(builtinToolNames(undefined), []);
});

// One table decides both what a leaf HAS (--tools) and whether it writes (its tree):
// every built-in carries its write flag there, and the classifier reads nothing else.
test("hasWriteTools reads the built-in table's own write flag, for every entry", () => {
  for (const [key, entry] of Object.entries(BUILTIN_TOOLS)) {
    equal(typeof entry.write, "boolean", `${key} carries its write flag`);
    equal(hasWriteTools(entry.name), entry.write, `${entry.name}: classifier and table agree`);
  }
});

// A hand-built codex plan never passes normalize, so the sandbox reads allowedTools
// itself — through the same classifier, case and PowerShell included.
test("codexSandbox classifies allowedTools with hasWriteTools", () => {
  equal(codexSandbox({ allowedTools: "Read,PowerShell" }, {}), "workspace-write");
  equal(codexSandbox({ allowedTools: "read,write" }, {}), "workspace-write");
  equal(codexSandbox({ allowedTools: "Read,Grep,Glob" }, {}), "read-only");
});
