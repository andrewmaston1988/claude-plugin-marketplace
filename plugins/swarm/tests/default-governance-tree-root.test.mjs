import { test } from "node:test";
import { equal } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildDispatch } from "../src/dispatch.mjs";
import { loadManifest } from "../src/manifest.mjs";

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

function world() {
  const root = mkdtempSync(join(tmpdir(), "swarm-default-tree-governance-"));
  const repo = join(root, "source-repo");
  const home = join(root, "swarm-home");
  const treeRoot = join(root, "external-trees");
  const tree = join(treeRoot, "C--source-repo", "run-1", "impl");
  const manifest = join(root, "manifest.json");
  const previousHome = process.env.SWARM_HOME;
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "source.txt"), "source\n");
  git(["add", "."], repo);
  git(["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], repo);
  git(["worktree", "add", "-q", "-b", "swarm/impl", tree], repo);
  process.env.SWARM_HOME = home;
  return {
    repo, tree, treeRoot, manifest,
    cfg: { treeRoot, concurrency: 1, resultInlineCap: 4000,
      providers: { claude: { enabled: true, allowedRoots: [repo] } } },
    cleanup() {
      if (previousHome === undefined) delete process.env.SWARM_HOME;
      else process.env.SWARM_HOME = previousHome;
      git(["worktree", "remove", "--force", tree], repo);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("loadManifest default governance io allows a treeRoot cwd by its source repo", () => {
  const w = world();
  try {
    writeFileSync(w.manifest, JSON.stringify({ cwd: w.repo, tasks: [
      { id: "impl", prompt: "work", provider: "claude", model: "claude-haiku-4-5-20251001", cwd: w.tree },
    ] }));
    equal(loadManifest(w.manifest, w.cfg, w.repo).tasks[0].cwd, w.tree);
  } finally { w.cleanup(); }
});

test("buildDispatch default governance io receives the configured treeRoot", () => {
  const w = world();
  try {
    const task = { id: "impl", prompt: "work", provider: "claude", model: "claude-haiku-4-5-20251001",
      cwd: w.tree, originalCwd: w.tree, allowedTools: "Read,Edit,Bash" };
    equal(buildDispatch(task, task.prompt, w.cfg).provider, "claude");
  } finally { w.cleanup(); }
});
