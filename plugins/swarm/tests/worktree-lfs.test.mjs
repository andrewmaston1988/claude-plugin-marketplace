import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { prepareIsolation } from "../src/worktree.mjs";

const CFG = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "x", allowedRoots: [] },
  resultInlineCap: 4000,
  worktreeBranchPrefix: "swarm/",
};

const lfs = spawnSync("git", ["lfs", "version"], { windowsHide: true });
const skip = lfs.status !== 0 && "git-lfs is not installed";

// A tree of an LFS repo must hold pointers: smudging every object into every tree
// filled the disk (2026-11-18, ~1.7 GB of concept art per tree of the CLAUDE repo).
test("a tree cut from an LFS repo holds pointers and reads clean", { skip, timeout: 60000 }, () => {
  const repo = mkdtempSync(join(tmpdir(), "swarm-lfs-repo-"));
  const resultsDir = mkdtempSync(join(tmpdir(), "swarm-lfs-res-"));
  const git = (...args) => spawnSync("git", args, { cwd: repo, windowsHide: true, encoding: "utf8" });
  let tree;
  try {
    git("init", "-q", "-b", "main");
    git("lfs", "install", "--local", "--skip-repo"); // the smudge filter only; no hooks on every checkout
    git("lfs", "track", "*.bin");
    writeFileSync(join(repo, "a.bin"), Buffer.alloc(64 * 1024, 7));
    git("add", ".gitattributes", "a.bin");
    git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
    const base = git("rev-parse", "HEAD").stdout.trim();

    tree = prepareIsolation({ id: "lfs", originalCwd: repo }, CFG, resultsDir, { addTimeoutMs: 30000, base });

    const file = join(tree.path, "a.bin");
    ok(statSync(file).size < 200, `a.bin is ${statSync(file).size} bytes; the object was smudged into the tree`);
    ok(readFileSync(file, "utf8").startsWith("version https://git-lfs"), "a.bin is an LFS pointer");
    equal(spawnSync("git", ["status", "--porcelain"], { cwd: tree.path, encoding: "utf8" }).stdout.trim(), "",
      "a pointer tree reads clean, so collect sees no uncommitted work");
  } finally {
    if (tree) spawnSync("git", ["worktree", "remove", "--force", tree.path], { cwd: repo, windowsHide: true });
    for (const d of [resultsDir, repo]) rmSync(d, { recursive: true, force: true });
  }
});
