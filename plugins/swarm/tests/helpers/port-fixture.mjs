// A real repo with a finished run's leaf worktree (swarm/<run>/<id>) and a separate
// porting worktree on a named branch — the shape the port nudge exists for.
//
// A fixture is a repo + worktrees + run records, which costs seconds to build. One
// template per shape is built per process and every call copies it: a copy needs the
// two path-keyed names renamed, the files that embed the home path rewritten, and each
// copied worktree rebound with `git worktree repair`.
import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
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

// The only thing that names a repo's default branch: a remote's HEAD. A fixture without
// one has no default branch, and the landing checks must say so.
export function publishDefault(repo, { branch = "main", remote = "origin" } = {}) {
  must(["update-ref", `refs/remotes/${remote}/${branch}`, must(["rev-parse", branch], repo)], repo);
  must(["symbolic-ref", `refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/${branch}`], repo);
}

// Templates live under SWARM_HOME: isolate-home.mjs removes it at process exit, so nothing
// outlives the run.
function templateRoot() {
  const root = join(process.env.SWARM_HOME || tmpdir(), "swarm-fixture-templates");
  mkdirSync(root, { recursive: true });
  return root;
}
const readdirSafe = (dir) => { try { return readdirSync(dir); } catch { return []; } };

function jsonFiles(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) jsonFiles(p, out);
    else if (e.name.endsWith(".json")) out.push(p);
  }
  return out;
}

// The fixture API over one home. Everything path-shaped derives from `home`/`repo`, so a
// copy is a new home handed to this same builder.
function makeFixture(home, repo) {
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

// Every form the home path takes on disk: raw, git's forward-slash rendering, and the
// JSON-escaped one the three record files hold.
function pathForms(from, to) {
  return [
    [from, to],
    [from.replaceAll("\\", "/"), to.replaceAll("\\", "/")],
    [JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1)],
  ];
}

// The five kinds of file a build writes the home prefix into: each linked worktree's
// `.git`, its admin `gitdir`, and the run's manifest, summary and per-tree records.
// The rest of `.git` holds relative pointers or content, and `run.log` a session id.
function pathEmbeddedFiles(home, repo, runsRoot) {
  const files = [];
  const adminDir = join(repo, ".git", "worktrees");
  for (const name of readdirSafe(adminDir)) {
    for (const file of [join(home, name, ".git"), join(adminDir, name, "gitdir")]) {
      if (existsSync(file)) files.push(file);
    }
  }
  return jsonFiles(runsRoot, files);
}

function rewritePaths(file, oldHome, newHome, oldKey, newKey) {
  const before = statSync(file);
  const text = readFileSync(file, "utf8");
  let next = text;
  for (const [from, to] of pathForms(oldHome, newHome)) next = next.split(from).join(to);
  if (oldKey !== newKey) next = next.split(oldKey).join(newKey);
  if (next === text) return;
  // Windows refuses to truncate the hidden `.git` file git writes, so the copy is replaced
  // rather than opened for write.
  rmSync(file);
  writeFileSync(file, next);
  // runLiveness trusts summary.json only while its mtime is not older than run.log's.
  utimesSync(file, before.atime, before.mtime);
}

// The runs dir and the taken log are keyed by the repo toplevel, so a copy needs both
// renamed or its records are invisible to the copy's own key.
function renameKeyed(home, oldKey, newKey) {
  if (oldKey === newKey) return;
  const runsDir = join(home, "runs");
  if (existsSync(join(runsDir, oldKey))) renameSync(join(runsDir, oldKey), join(runsDir, newKey));
  const takenDir = join(home, "taken");
  for (const name of readdirSafe(takenDir)) {
    if (!name.startsWith(`${oldKey}.jsonl`)) continue;
    renameSync(join(takenDir, name), join(takenDir, `${newKey}${name.slice(oldKey.length)}`));
  }
}

function repairWorktrees(home, repo) {
  // The admin dir's basename IS the linked worktree's dirname. The main worktree's path
  // derives from cwd, and passing it fails — only the linked ones need repair.
  for (const name of readdirSafe(join(repo, ".git", "worktrees"))) {
    must(["worktree", "repair", join(home, name)], repo);
  }
}

function copyHome(template, { root = tmpdir(), prefix = "port-nudge-" } = {}) {
  mkdirSync(root, { recursive: true });
  const home = mkdtempSync(join(root, prefix));
  cpSync(template.home, home, { recursive: true, preserveTimestamps: true });
  const repo = join(home, "repo");
  const toplevel = realRepoToplevel(repo) || repo;
  const oldKey = basename(template.runsRoot);
  const newKey = runsKeyFor(toplevel);
  renameKeyed(home, oldKey, newKey);
  for (const file of pathEmbeddedFiles(home, repo, join(home, "runs", newKey))) {
    rewritePaths(file, template.home, home, oldKey, newKey);
  }
  repairWorktrees(home, repo);
  return { home, repo };
}

let portBase = null;

function buildPortBase() {
  const home = mkdtempSync(join(templateRoot(), "base-"));
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  must(["init", "-q", "-b", "main"], repo);
  writeCommit(repo, "a.txt", "base\n", "init");
  return makeFixture(home, repo);
}

const portTemplate = () => (portBase ??= buildPortBase());

export function portFixture() {
  const copy = copyHome(portTemplate());
  return makeFixture(copy.home, copy.repo);
}

// The cached template itself, for the row that proves a copy equals it. Its cleanup is a
// no-op: removing it would strand every later copy in the process.
export const portFixtureTemplate = () => ({ ...portTemplate(), cleanup: () => {} });

// The shape a superseded port leaves: nothing on the default branch holds the lane's
// commits or their patch, so every content check reads unlanded.
function buildTaken({ run = "run-1", id = "implement-rating", branch = "feat", launcher = null } = {}) {
  const copy = copyHome(portTemplate(), { root: templateRoot(), prefix: "taken-" });
  const f = makeFixture(copy.home, copy.repo);
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

const takenTemplates = new Map();

function takenTemplate(opts = {}) {
  const key = JSON.stringify(opts);
  let template = takenTemplates.get(key);
  if (!template) {
    template = buildTaken(opts);
    takenTemplates.set(key, template);
  }
  return template;
}

export const takenFixtureTemplate = (opts) => ({ ...takenTemplate(opts), cleanup: () => {} });

export function takenFixture(opts) {
  const template = takenTemplate(opts);
  const copy = copyHome(template);
  const api = makeFixture(copy.home, copy.repo);
  const at = (path) => join(api.home, relative(template.home, path));
  return {
    ...api,
    runName: template.runName,
    branch: template.branch,
    runDir: join(api.runsRoot, template.runName),
    lane: { ...template.lane, path: at(template.lane.path) },
    port: at(template.port),
    picks: template.picks,
    review: template.review,
    portTip: template.portTip,
    squash: template.squash,
  };
}
