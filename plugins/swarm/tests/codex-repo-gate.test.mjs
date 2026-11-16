// When `codex exec` may start at all: it refuses a cwd outside a Git repository
// unless the launch allowance is passed. A read-only leaf is a reader, so the
// allowance follows the sandbox; a writer runs in a worktree and keeps the gate.
import "./helpers/isolate-home.mjs"; import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildCodexInvocation } from "../src/codex.mjs";
import { addDirsOf } from "./helpers/fake-io.mjs";

const SHIM = fileURLToPath(new URL("./shims/codex-shim.mjs", import.meta.url));

// A read-only leaf is a reader, so it gets the allowance; so does the generated
// digest, whose cwd is engine scratch. The flag sits with the other exec flags —
// the shim rejects exec options after `resume` — and is pushed once however many
// conditions hold.
test("Codex: --skip-git-repo-check is emitted once for a read-only leaf and a scratch digest, before resume", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-codex-roots-"));
  try {
    const resultsDir = join(dir, "run");
    const digest = buildCodexInvocation({
      model: "gpt-5-codex", effort: "high", allowedTools: "Read,Write", isDigest: true,
      cwd: join(resultsDir, "scratch-__digest"), originalCwd: dir, resume: "thread-9",
      writeRoots: [
        { path: join(resultsDir, "scratch-__digest"), kind: "directory" },
        { path: join(resultsDir, "report.md"), kind: "file" },
      ],
    }, "write the report", {});
    const flagAt = digest.argv.indexOf("--skip-git-repo-check");
    const resumeAt = digest.argv.indexOf("resume");
    ok(flagAt > 0 && resumeAt > flagAt, `must precede resume: ${digest.argv.join(" ")}`);
    equal(digest.argv.filter((arg) => arg === "--skip-git-repo-check").length, 1, digest.argv.join(" "));
    equal(digest.argv[resumeAt + 1], "thread-9");
    const shim = spawnSync(process.execPath, [SHIM, ...digest.argv.slice(1)], { encoding: "utf8" });
    equal(shim.status, 0, `the shim rejects exec options after resume: ${shim.stderr}`);
    equal(digest.argv[digest.argv.indexOf("--sandbox") + 1], "workspace-write");

    // A writer keeps the repo-root gate: its tree is a repository.
    const leaf = buildCodexInvocation({
      model: "gpt-5-codex", allowedTools: "Read,Write", cwd: dir, originalCwd: dir,
    }, "inspect", {});
    ok(!leaf.argv.includes("--skip-git-repo-check"), leaf.argv.join(" "));

    // A read-only digest is a reader too, so launching in place no longer exempts it.
    const inPlace = buildCodexInvocation({
      model: "gpt-5-codex", allowedTools: "Read", isDigest: true, cwd: dir, originalCwd: dir,
    }, "summarize", {});
    equal(inPlace.argv.filter((arg) => arg === "--skip-git-repo-check").length, 1, inPlace.argv.join(" "));

    // Both conditions at once — read-only and launched from scratch — still one flag.
    const both = buildCodexInvocation({
      model: "gpt-5-codex", allowedTools: "Read", isDigest: true, cwd: join(dir, "scratch"), originalCwd: dir,
    }, "summarize", {});
    equal(both.argv.filter((arg) => arg === "--skip-git-repo-check").length, 1, both.argv.join(" "));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The digest's sandbox follows the same write-capability rule as any other task:
// no report block, no Write, so read-only — and a read-only leaf is a reader, so
// it gets the launch allowance wherever it runs.
test("Codex: a read-only digest is read-only sandboxed, with no --add-dir and one launch allowance", () => {
  const invocation = buildCodexInvocation({
    model: "gpt-5-codex", allowedTools: "Read", isDigest: true,
    cwd: "C:/work", originalCwd: "C:/work",
  }, "summarize", {});
  equal(invocation.argv[invocation.argv.indexOf("--sandbox") + 1], "read-only");
  deepEqual(addDirsOf(invocation.argv), []);
  equal(invocation.argv.filter((arg) => arg === "--skip-git-repo-check").length, 1, invocation.argv.join(" "));
  ok(!invocation.argv.includes("--settings"));
});

// The rts-mobile shape: a read-only finder at a cwd that is no repository at all.
// The allowance rides with the other exec flags, so a resumed turn still gets it.
test("Codex: a read-only leaf gets one --skip-git-repo-check, before resume", () => {
  const leaf = buildCodexInvocation({
    model: "gpt-5-codex", allowedTools: "Read,Grep,Glob", cwd: "C:/code", originalCwd: "C:/code",
  }, "inspect", {}).argv;
  equal(leaf.filter((arg) => arg === "--skip-git-repo-check").length, 1, leaf.join(" "));

  const resumed = buildCodexInvocation({
    model: "gpt-5-codex", allowedTools: "Read,Grep,Glob", cwd: "C:/code", originalCwd: "C:/code",
    resume: "thread-2",
  }, "inspect", {}).argv;
  const flagAt = resumed.indexOf("--skip-git-repo-check");
  const resumeAt = resumed.indexOf("resume");
  equal(resumed.filter((arg) => arg === "--skip-git-repo-check").length, 1, resumed.join(" "));
  ok(flagAt > 0 && resumeAt > flagAt, `must precede resume: ${resumed.join(" ")}`);
});

// Every leaf that can write runs in a worktree, which is a repository, so the gate
// stays on — including the rows where the tree name, not the tool list, is the tell.
test("Codex: a write-capable leaf keeps the repo-root gate, with no --skip-git-repo-check", () => {
  for (const allowedTools of ["Read,Grep,Glob,Bash", "Read,Edit", "Read,Write", "Read,NotebookEdit"]) {
    const argv = buildCodexInvocation({
      model: "gpt-5-codex", allowedTools, cwd: "C:/work", originalCwd: "C:/work",
    }, "inspect", {}).argv;
    ok(!argv.includes("--skip-git-repo-check"), `${allowedTools}: ${argv.join(" ")}`);
  }
  const treeNamed = buildCodexInvocation({
    model: "gpt-5-codex", allowedTools: "Read", worktreeName: "impl",
    cwd: "C:/work", originalCwd: "C:/work",
  }, "inspect", {}).argv;
  ok(!treeNamed.includes("--skip-git-repo-check"), treeNamed.join(" "));
});
