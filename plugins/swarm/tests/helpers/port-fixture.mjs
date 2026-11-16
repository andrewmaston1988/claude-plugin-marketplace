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
    // A pick onto the leaf's own parent replays the identical commit — same parent,
    // tree, message, author and (same-second) timestamp — so git lands the leaf's own
    // SHA and reachability answers before any extra base is tried. Give the target
    // branch a commit of its own first, and prove the pick is a distinct commit.
    cherryPick: (path, sha) => {
      if (must(["rev-parse", "HEAD"], path) === must(["rev-parse", `${sha}^`], path)) {
        writeCommit(path, "port-base.txt", "port base\n", "port base");
      }
      must(["cherry-pick", sha], path);
      const picked = must(["rev-parse", "HEAD"], path);
      if (picked === sha) throw new Error(`cherry-pick of ${sha} reproduced the leaf's own commit`);
      return picked;
    },
    replay: (path, from, branch) => {
      const patch = git(["diff", from, branch], repo);
      if (patch.status !== 0) throw new Error(`git diff ${from} ${branch} failed: ${patch.stderr}`);
      return must(["apply"], path, { input: patch.stdout + "\n" });
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

// The shape reported in tv11-build-1 (2026-11-15): the lane's two commits were
// cherry-picked into feature branch `branch` (the second resolved through
// `--continue`), a review commit rewrote the same lines, the branch was
// squash-landed on main and deleted. Nothing on main holds a lane commit or its
// patch, so every content check reads unlanded — the state the taken log exists
// to settle. Lines sit far apart so only the pick we mean conflicts.
export function takenFixture({ run = "run-1", id = "implement-rating", branch = "feat", launcher = null } = {}) {
  const f = portFixture();
  const { repo, home } = f;
  const body = (over = {}) => Array.from({ length: 15 }, (_, i) => over[i + 1] ?? `line${String(i + 1).padStart(2, "0")}`).join("\n") + "\n";

  writeCommit(repo, "app.txt", body(), "app base");
  const laneBranch = `swarm/${run}/${id}`;
  const lanePath = join(home, `leaf-${run}-${id}`);
  must(["worktree", "add", "-q", "-b", laneBranch, lanePath, "main"], repo);
  writeCommit(lanePath, "app.txt", body({ 1: "line01 alpha lane" }), "lane work 1");
  const one = must(["rev-parse", "HEAD"], lanePath);
  writeCommit(lanePath, "app.txt", body({ 1: "line01 alpha lane", 13: "line13 gamma lane" }), "lane work 2");
  const two = must(["rev-parse", "HEAD"], lanePath);

  const port = f.porting("porting", branch);
  // The port base rewrites the line the second pick also rewrites: that pick conflicts.
  writeCommit(port, "app.txt", body({ 8: "line08 beta port", 13: "line13 gamma port" }), "port base");
  must(["cherry-pick", one], port);
  const pickOne = must(["rev-parse", "HEAD"], port);
  const conflicted = git(["cherry-pick", two], port);
  if (conflicted.status === 0) throw new Error("the fixture's second pick did not conflict");
  writeFileSync(join(port, "app.txt"), body({ 1: "line01 alpha lane", 8: "line08 beta port", 13: "line13 gamma lane" }));
  must(["add", "app.txt"], port);
  must(["cherry-pick", "--continue", "--no-edit"], port);
  const pickTwo = must(["rev-parse", "HEAD"], port);

  writeCommit(port, "app.txt", body({ 1: "line01 alpha reviewed", 8: "line08 beta port", 13: "line13 gamma reviewed" }), "review: rewrite the lane's lines");
  const review = must(["rev-parse", "HEAD"], port);
  // The review commit is the branch's tip: the last proof a taken record can hold
  // once the branch itself is deleted.
  const portTip = review;

  must(["merge", "--squash", branch], repo);
  must(["commit", "-qm", `land ${branch}`], repo);
  const squash = must(["rev-parse", "HEAD"], repo);
  must(["worktree", "remove", "--force", port], repo);
  must(["branch", "-D", branch], repo);

  const lane = { id, branch: laneBranch, path: lanePath, commits: [one, two], tip: two };
  const runDir = f.run(run, { launcher, leaves: [lane] });
  return { ...f, runName: run, runDir, lane, branch, port, picks: [pickOne, pickTwo], review, portTip, squash };
}
