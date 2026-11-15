// The win32 half of the codex invocation: casing is folded by
// normalizeForCompare on win32 only; on posix two cased spellings are genuinely
// two directories.
//
// Its own file so the diff-aware Windows run always exercises it, not only when
// something in codex.test.mjs's closure changed.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCodexInvocation } from "../src/codex.mjs";
import { addDirsOf } from "./helpers/fake-io.mjs";

test("Codex: win32 casing cannot produce a duplicate --add-dir", { skip: process.platform !== "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-codex-roots-"));
  try {
    const run = join(dir, "run");
    const invocation = buildCodexInvocation({
      model: "gpt-5-codex", allowedTools: "Read,Write",
      cwd: join(dir, "repo"), originalCwd: join(dir, "repo"),
      additionalDirs: [run.toUpperCase()],
      writeRoots: [{ path: join(run.toLowerCase(), "report.md"), kind: "file" }],
    }, "write the report", {});
    deepEqual(addDirsOf(invocation.argv), [run.toUpperCase()]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
