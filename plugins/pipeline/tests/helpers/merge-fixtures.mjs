// merge-fixtures.mjs — temp repos, isolated homes, and the merge subprocess.
// Shared by merge-worktree.test.mjs (isolation) and merge-park.test.mjs (park
// and land-resume), which is why they live here rather than in either file.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { connectPath, close, projectAdd, rowAdd, rowUpdate } from "../../src/db/index.mjs";

export const MERGE_MJS = fileURLToPath(new URL("../../skills/merge/scripts/merge.mjs", import.meta.url));
export const SUCCESS_LINE = "merge.mjs — complete";
export const PLAN_MIN = "# feat\n\n## Goal\n\nLand the feature.\n\n## Current Status\n\n- in progress\n";

export function git(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

export function gitMaybe(cwd, ...args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

export function makeRepoDir() {
  const tmp = mkdtempSync(join(tmpdir(), "merge-wt-"));
  const repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  return { tmp, repo };
}

export function makeBaseRepo(repo, { features = ["feat-x"], claudeMd = null, plan = PLAN_MIN } = {}) {
  git(repo, "init", "--initial-branch=master");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "init\n");
  writeFileSync(join(repo, "notes.txt"), "note\n");
  mkdirSync(join(repo, "plans"), { recursive: true });
  for (const f of features) writeFileSync(join(repo, "plans", `${f}.md`), plan);
  if (claudeMd) writeFileSync(join(repo, "CLAUDE.md"), claudeMd);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "seed");
  for (const f of features) {
    git(repo, "checkout", "-b", `autonomous/${f}`);
    writeFileSync(join(repo, `${f}.txt`), `${f}\n`);
    if (f === "feat-x") writeFileSync(join(repo, "feature.txt"), "feat\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", f);
    git(repo, "checkout", "master");
  }
  return repo;
}

export function addOrigin(tmp, repo) {
  const bare = join(tmp, "origin.git");
  spawnSync("git", ["init", "--bare", "--initial-branch=master", bare], { encoding: "utf8" });
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "origin", "master");
  return bare;
}

export function dbFile(home) {
  return process.platform === "linux"
    ? join(home, ".local", "share", "pipeline", "pipeline.db")
    : join(home, ".pipeline", "pipeline.db");
}

export function homeEnv(home) {
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) delete env[k];
  return env;
}

export function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "merge-wt-home-"));
  mkdirSync(dirname(dbFile(home)), { recursive: true });
  return home;
}

export function seedRows(home, repo, features) {
  const db = connectPath(dbFile(home));
  try {
    const project = basename(repo);
    projectAdd(db, { name: project, rootPath: repo });
    for (const feature of features) {
      rowAdd(db, project, {
        feature,
        planFile: join(repo, "plans", `${feature}.md`),
        stage: "merge",
      });
      rowUpdate(db, project, feature, { qa_pass: 1 });
    }
  } finally { close(db); }
}

export function writeConfig(home, cfg) {
  mkdirSync(join(home, ".pipeline"), { recursive: true });
  writeFileSync(join(home, ".pipeline", "config.json"), JSON.stringify(cfg), "utf8");
}

export function writeHook(home, name, body) {
  const path = join(home, `${name}.mjs`);
  writeFileSync(path, body, "utf8");
  return path;
}

export function runMerge(repo, home, branches, extraArgs = []) {
  return spawnSync(process.execPath, [
    MERGE_MJS, "--branches", branches, "--project-dir", repo,
    "--target-branch", "master", "--no-rebase", ...extraArgs,
  ], { env: homeEnv(home), encoding: "utf8", timeout: 120_000 });
}

export function runLandOnly(repo, home, extraArgs = []) {
  return spawnSync(process.execPath, [
    MERGE_MJS, "--land-only", "--project-dir", repo,
    "--target-branch", "master", "--skip-smoke", ...extraArgs,
  ], { env: homeEnv(home), encoding: "utf8", timeout: 120_000 });
}

export function parkedSha(repo) {
  const r = gitMaybe(repo, "rev-parse", "--verify", "--quiet", "refs/merge/master");
  return r.status === 0 ? r.stdout.trim() : null;
}

// Same run, but polls `git worktree list` so a row can prove a merge worktree
// existed while the merge was in flight.
export function runMergeWatched(repo, home, branches, extraArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      MERGE_MJS, "--branches", branches, "--project-dir", repo,
      "--target-branch", "master", "--no-rebase", ...extraArgs,
    ], { env: homeEnv(home) });
    let stdout = "";
    let stderr = "";
    let sawWorktree = false;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setInterval(() => {
      const listing = gitMaybe(repo, "worktree", "list", "--porcelain").stdout ?? "";
      if ((listing.match(/^worktree /gm) ?? []).length > 1) sawWorktree = true;
    }, 100);
    child.on("close", (status) => {
      clearInterval(timer);
      resolve({ status, stdout, stderr, sawWorktree });
    });
  });
}

export function mergeWorktreeFromStdout(stdout) {
  const m = /^\[0\] Merge worktree: (.+)$/m.exec(stdout);
  return m ? m[1].trim() : null;
}

export function worktreeCount(repo) {
  const listing = git(repo, "worktree", "list", "--porcelain");
  return (listing.match(/^worktree /gm) ?? []).length;
}
