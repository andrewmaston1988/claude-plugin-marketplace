// A real repo with a finished run's leaf worktree (swarm/<run>/<id>) and a separate
// porting worktree on a named branch — the shape the port nudge exists for.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realRepoToplevel } from "../../src/manifest-leaf-guard.mjs";
import { runsKeyFor } from "../../src/config.mjs";
import { makeGit } from "../../src/prune.mjs";

export function git(args, cwd, opts = {}) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", windowsHide: true, input: opts.input });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

export function must(args, cwd, opts) {
  const r = git(args, cwd, opts);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout;
}

export function writeCommit(cwd, file, body, message) {
  writeFileSync(join(cwd, file), body);
  must(["add", "-A"], cwd);
  must(["commit", "-qm", message], cwd);
}

export function portFixture() {
  const home = mkdtempSync(join(tmpdir(), "port-nudge-"));
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  must(["init", "-q", "-b", "main"], repo);
  writeCommit(repo, "a.txt", "base\n", "init");
  const toplevel = realRepoToplevel(repo) || repo;
  const runsRoot = join(home, "runs", runsKeyFor(toplevel));
  const cfg = { worktreeBranchPrefix: "swarm/", treeRoot: join(home, "worktrees") };
  const spawn = spawnSync;
  const gitRunner = makeGit(spawn);

  // A leaf writer's tree: a real worktree on its own swarm branch, one commit.
  const leaf = (runName, id) => {
    const branch = `swarm/${runName}/${id}`;
    const path = join(home, `leaf-${runName}-${id}`);
    must(["worktree", "add", "-q", "-b", branch, path, "main"], repo);
    writeCommit(path, `${runName}-${id}.txt`, `${runName} ${id} work\n`, `${runName} ${id} work`);
    return { id, branch, path, sha: must(["rev-parse", "HEAD"], path) };
  };

  // The run dir a finished dispatch leaves: a summary naming its kept trees, the
  // launcher's run-start, and the per-tree records a foreign session is found by.
  const run = (name, { launcher = null, tasks = [{ id: "leaf", state: "ok" }], leaves = [] } = {}) => {
    const dir = join(runsRoot, name);
    mkdirSync(join(dir, "trees"), { recursive: true });
    const t = Date.now() - 60_000;
    const kept = leaves.map((l) => ({ name: l.id, branch: l.branch, path: l.path, repo }));
    writeFileSync(join(dir, "run.log"), JSON.stringify({ ts: t, event: "run-start", ...(launcher ? { launcher } : {}), tasks: [] }) + "\n");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ resultsDir: dir, cwd: repo, tasks: [] }));
    writeFileSync(join(dir, "summary.json"), JSON.stringify({
      started: new Date(t).toISOString(),
      finished: new Date(t + 1).toISOString(),
      tasks,
      blocked: [],
      worktreesKept: kept,
      totalTokens: null,
    }));
    for (const row of kept) {
      writeFileSync(join(dir, "trees", `${row.name}.json`),
        JSON.stringify({ name: row.name, path: row.path, branch: row.branch, repo, state: "ready" }));
    }
    return dir;
  };

  const porting = (name = "porting", branch = "feat") => {
    const path = join(home, name);
    must(["worktree", "add", "-q", "-b", branch, path, "main"], repo);
    return path;
  };

  return {
    home,
    repo,
    toplevel,
    runsRoot,
    cfg,
    spawn,
    git: gitRunner,
    leaf,
    run,
    porting,
    cherryPick: (path, sha) => must(["cherry-pick", sha], path),
    replay: (path, from, branch) => {
      const patch = git(["diff", from, branch], repo);
      if (patch.status !== 0) throw new Error(`git diff ${from} ${branch} failed: ${patch.stderr}`);
      return must(["apply"], path, { input: patch.stdout + "\n" });
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
