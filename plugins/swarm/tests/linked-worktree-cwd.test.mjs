import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadManifest } from "../src/manifest.mjs";
import { runPlan } from "../src/scheduler.mjs";
import { readResult } from "../src/results.mjs";
import { CFG, writeManifest } from "./helpers/manifest-fixtures.mjs";
import { fakeSpawnFactory, makeIo } from "./helpers/fake-io.mjs";

// A global core.hooksPath (git-lfs, indexers) adds seconds per git call; swarm's own git calls inherit this.
Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null" });

const git = (args, cwd) =>
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", windowsHide: true }).stdout.trim();

// A writer pointed into a LINKED worktree must get a tree of that checkout, at its depth.
// The run is still filed under the main checkout; only the tree's root is the linked one.
test("a writer whose cwd is inside a linked worktree gets a tree of that worktree's HEAD, at its depth", async () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-linked-"));
  const main = join(root, "main"), linked = join(root, "linked");
  try {
    mkdirSync(join(main, "sub"), { recursive: true });
    git(["init", "-q", "-b", "main"], main);
    writeFileSync(join(main, "sub", "a.txt"), "a\n");
    git(["add", "."], main);
    git(["commit", "-q", "-m", "init"], main);
    git(["worktree", "add", "-q", "--detach", linked], main);
    writeFileSync(join(linked, "sub", "b.txt"), "b\n");
    git(["add", "."], linked);
    git(["commit", "-q", "-m", "linked only"], linked);
    const linkedHead = git(["rev-parse", "HEAD"], linked);

    const sub = join(linked, "sub");
    const p = writeManifest(root, { name: "linked", tasks: [
      { id: "impl", prompt: "p", provider: "claude", model: "claude-haiku-4-5-20251001", allowedTools: "Read,Bash", cwd: sub },
    ] });
    const plan = loadManifest(p, CFG, sub);
    // HEAD is read while the leaf runs: an unchanged tree is removed at collect.
    const cwds = [], heads = [];
    await runPlan(plan, CFG, makeIo(fakeSpawnFactory((call) => {
      cwds.push(call.opts.cwd);
      heads.push(git(["rev-parse", "HEAD"], call.opts.cwd));
      return {};
    })));

    equal(/outside its repo/.test(readResult(plan.resultsDir, "impl")?.output ?? ""), false, "the leaf must not fail at worktree setup");
    equal(cwds.length, 1, "the leaf never spawned: its tree was refused");
    equal(resolve(cwds[0]), join(resolve(plan.resultsDir, "wt-impl"), "sub"), "the leaf sits at its declared depth inside the tree");
    equal(heads[0], linkedHead, "the tree is cut from the linked worktree, not main");
  } finally {
    spawnSync("git", ["worktree", "prune"], { cwd: main, windowsHide: true });
    rmSync(root, { recursive: true, force: true });
  }
});
