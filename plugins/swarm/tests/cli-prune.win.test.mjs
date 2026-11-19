// Windows-only: git prints its toplevel with forward slashes in the filesystem's own case,
// while a recorded tree path carries backslashes and the case swarm derived. A raw string
// comparison calls every real worktree "unlinked" — and then destroys its uncommitted work.
import "./helpers/isolate-home.mjs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCliInProcess } from "./helpers/cli.mjs";
import { gitOut } from "./helpers/cli-fixture.mjs";
import { prepareIsolation, WORKTREE_ADD_TIMEOUT_MS } from "../src/worktree.mjs";
import { pruneFixture, writeKilledRun, dropSnapPrune } from "./helpers/prune-fixture.mjs";

const cliCfg = (dir) => ({ worktreeBranchPrefix: "swarm/", treeRoot: join(dir, "home", "worktrees") });
const skip = process.platform === "win32" ? false : "Windows-only: path case and separator spelling";

test("A7: a recorded path with backslashes and a different case is still a worktree root", { skip }, async () => {
  const f = pruneFixture();
  try {
    const wt = prepareIsolation({ id: "impl", originalCwd: f.repo, cwd: f.repo }, cliCfg(f.dir), f.resultsDir,
      { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: f.sha });
    writeFileSync(join(wt.path, "scratch.txt"), "uncommitted\n");
    // A killed run wrote no summary: the per-tree record is the only name for this row, so
    // its spelling is the one discovery actually uses.
    writeKilledRun(f);
    const record = JSON.parse(readFileSync(join(f.resultsDir, "trees", "impl.json"), "utf8"));
    record.path = wt.path.replaceAll("/", "\\").toUpperCase();
    writeFileSync(join(f.resultsDir, "trees", "impl.json"), JSON.stringify(record));

    const r = await runCliInProcess(["prune", f.resultsDir, "--dry-run"], { cwd: f.dir, env: { SWARM_HOME: join(f.dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(/1 uncommitted/.test(r.stdout), `a real worktree's dirty tree must be measured: ${r.stdout}${r.stderr}`);
    ok(!/unlinked directory/.test(r.stdout + r.stderr), `a worktree root must never be called unlinked: ${r.stdout}${r.stderr}`);
    ok(existsSync(join(wt.path, "scratch.txt")), "the uncommitted file survives");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", f.tree], { cwd: f.repo, windowsHide: true });
    dropSnapPrune(f);
  }
});
