// merge-worktree.test.mjs — end-to-end: every mutating git call happens in a
// throwaway worktree, and the shared checkout sees at most one fast-forward.
//
// Fixtures are temp repos (most with a bare origin). The merge runs as a real
// subprocess against an isolated home, so no network and no real ~/.pipeline.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync,
} from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { connectPath, close, projectAdd, rowAdd, rowUpdate } from "../src/db/index.mjs";
import { featureWorktreePath } from "../src/worktree-paths.mjs";

const MERGE_MJS = fileURLToPath(new URL("../skills/merge/scripts/merge.mjs", import.meta.url));
const SUCCESS_LINE = "merge.mjs — complete";
const PLAN_MIN = "# feat\n\n## Goal\n\nLand the feature.\n\n## Current Status\n\n- in progress\n";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function git(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function gitMaybe(cwd, ...args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function makeRepoDir() {
  const tmp = mkdtempSync(join(tmpdir(), "merge-wt-"));
  const repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  return { tmp, repo };
}

function makeBaseRepo(repo, { features = ["feat-x"], claudeMd = null, plan = PLAN_MIN } = {}) {
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

function addOrigin(tmp, repo) {
  const bare = join(tmp, "origin.git");
  spawnSync("git", ["init", "--bare", "--initial-branch=master", bare], { encoding: "utf8" });
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "origin", "master");
  return bare;
}

function dbFile(home) {
  return process.platform === "linux"
    ? join(home, ".local", "share", "pipeline", "pipeline.db")
    : join(home, ".pipeline", "pipeline.db");
}

function homeEnv(home) {
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) delete env[k];
  return env;
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "merge-wt-home-"));
  mkdirSync(dirname(dbFile(home)), { recursive: true });
  return home;
}

function seedRows(home, repo, features) {
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

function writeConfig(home, cfg) {
  mkdirSync(join(home, ".pipeline"), { recursive: true });
  writeFileSync(join(home, ".pipeline", "config.json"), JSON.stringify(cfg), "utf8");
}

function writeHook(home, name, body) {
  const path = join(home, `${name}.mjs`);
  writeFileSync(path, body, "utf8");
  return path;
}

function runMerge(repo, home, branches, extraArgs = []) {
  return spawnSync(process.execPath, [
    MERGE_MJS, "--branches", branches, "--project-dir", repo,
    "--target-branch", "master", "--no-rebase", ...extraArgs,
  ], { env: homeEnv(home), encoding: "utf8", timeout: 120_000 });
}

function runLandOnly(repo, home, extraArgs = []) {
  return spawnSync(process.execPath, [
    MERGE_MJS, "--land-only", "--project-dir", repo,
    "--target-branch", "master", "--skip-smoke", ...extraArgs,
  ], { env: homeEnv(home), encoding: "utf8", timeout: 120_000 });
}

function parkedSha(repo) {
  const r = gitMaybe(repo, "rev-parse", "--verify", "--quiet", "refs/merge/master");
  return r.status === 0 ? r.stdout.trim() : null;
}

// Same run, but polls `git worktree list` so the row can prove a merge
// worktree existed while the merge was in flight.
function runMergeWatched(repo, home, branches, extraArgs = []) {
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

function mergeWorktreeFromStdout(stdout) {
  const m = /^\[0\] Merge worktree: (.+)$/m.exec(stdout);
  return m ? m[1].trim() : null;
}

function worktreeCount(repo) {
  const listing = git(repo, "worktree", "list", "--porcelain");
  return (listing.match(/^worktree /gm) ?? []).length;
}

// ── A1 — one fast-forward, no stash, no worktree left ────────────────────────

test("A1: a successful merge moves the shared checkout once, by fast-forward, and leaves no worktree", async () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    makeBaseRepo(repo);
    addOrigin(tmp, repo);
    seedRows(home, repo, ["feat-x"]);
    const beforeSha = git(repo, "rev-parse", "HEAD");
    const beforeReflog = git(repo, "reflog", "show", "HEAD", "--format=%H").split("\n").filter(Boolean).length;

    const r = await runMergeWatched(repo, home, "autonomous/feat-x");

    equal(r.status, 0, `clean merge must exit 0; stderr=${r.stderr}`);
    ok(r.stdout.includes(SUCCESS_LINE), `success line missing: ${r.stdout}`);
    ok(r.sawWorktree, "no merge worktree was ever present during the run");

    const wtPath = mergeWorktreeFromStdout(r.stdout);
    ok(wtPath, `the merge worktree path must be printed: ${r.stdout}`);
    ok(!existsSync(wtPath), `the merge worktree must be gone afterwards: ${wtPath}`);

    const afterReflog = git(repo, "reflog", "show", "HEAD", "--format=%H").split("\n").filter(Boolean).length;
    equal(afterReflog, beforeReflog + 1, "the shared HEAD must move exactly once");
    const subject = git(repo, "reflog", "-1", "--format=%gs");
    ok(/fast-forward/i.test(subject), `the single move must be a fast-forward; got '${subject}'`);
    equal(git(repo, "rev-parse", "HEAD@{1}"), beforeSha, "the fast-forward starts at the pre-merge head");
    equal(git(repo, "stash", "list"), "", "the merge must not leave a stash entry");
    equal(worktreeCount(repo), 1, "no merge worktree may remain");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── A2 — a failed merge leaves another session's edit byte-identical ─────────

test("A2: an on_merge hook failure leaves the shared checkout's uncommitted edit intact", () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    makeBaseRepo(repo);
    seedRows(home, repo, ["feat-x"]);
    writeFileSync(join(repo, "notes.txt"), "another session's edit\n", "utf8");
    const hook = writeHook(home, "fail-hook", "process.exit(1);\n");
    writeConfig(home, { hooks: { on_merge: hook } });

    const r = runMerge(repo, home, "autonomous/feat-x");

    equal(r.status, 6, `a hook failure must exit 6; stderr=${r.stderr}`);
    ok(!r.stdout.includes(SUCCESS_LINE), `success line printed on a failed merge: ${r.stdout}`);
    equal(readFileSync(join(repo, "notes.txt"), "utf8"), "another session's edit\n",
      "the uncommitted edit must be byte-identical");
    equal(worktreeCount(repo), 1, "no merge worktree may remain after a failure");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── A3 — a foreign staged file is never committed by the merge ───────────────

test("A3: a foreign staged file stays staged and never reaches the merge commit", () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    makeBaseRepo(repo);
    addOrigin(tmp, repo);
    seedRows(home, repo, ["feat-x"]);
    writeFileSync(join(repo, "foreign.txt"), "foreign\n", "utf8");
    git(repo, "add", "foreign.txt");

    const r = runMerge(repo, home, "autonomous/feat-x");

    equal(r.status, 0, `clean merge must exit 0; stderr=${r.stderr}`);
    equal(git(repo, "ls-tree", "-r", "HEAD", "--", "foreign.txt"), "",
      "foreign.txt must not be in the merged tree");
    equal(git(repo, "status", "--porcelain", "--", "foreign.txt"), "A  foreign.txt",
      "foreign.txt must still be staged, untouched");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── A4 — the plan close lands in the merge's own commits ─────────────────────
// The branch edits its own plan, so a status write before the squash would be a
// staged plan edit and `git merge --squash` would refuse.

test("A4: a branch that edits its own plan closes it in the merge, not the shared checkout", () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    makeBaseRepo(repo);
    addOrigin(tmp, repo);
    git(repo, "checkout", "autonomous/feat-x");
    writeFileSync(join(repo, "plans", "feat-x.md"), PLAN_MIN + "\n## Notes\n\nbranch edit\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "branch edits its own plan");
    git(repo, "checkout", "master");
    seedRows(home, repo, ["feat-x"]);

    const r = runMerge(repo, home, "autonomous/feat-x");

    equal(r.status, 0, `merge must exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
    const tree = git(repo, "ls-tree", "-r", "--name-only", "HEAD");
    ok(tree.includes("feat-x.txt"), `the squash must be in HEAD: ${tree}`);
    equal(git(repo, "status", "--porcelain"), "", "the shared checkout must be clean");

    const closed = git(repo, "show", "HEAD:plans/complete/feat-x.md");
    ok(/merged/i.test(closed), `the closed plan must carry the merged status: ${closed}`);
    ok(!tree.split("\n").includes("plans/feat-x.md"),
      `the plan must be absent from plans/ in HEAD: ${tree}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── A9 — a refused land with origin: exit 0, report, no smoke ────────────────

test("A9: an overlapping edit in the shared checkout yields a reported refusal, exit 0, no smoke", () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    const marker = join(repo, "smoke-ran");
    const claudeMd = `# Repo\n\n## Smoke check\n\n\`\`\`bash\nnode -e "require('fs').writeFileSync('smoke-ran','x')"\n\`\`\`\n`;
    makeBaseRepo(repo, { claudeMd });
    const bare = addOrigin(tmp, repo);
    seedRows(home, repo, ["feat-x"]);
    // Overlaps the merge: the branch adds feature.txt to master.
    writeFileSync(join(repo, "feature.txt"), "someone else's draft\n", "utf8");
    const sharedBefore = git(repo, "rev-parse", "master");

    const r = runMerge(repo, home, "autonomous/feat-x");

    equal(r.status, 0, `a refused land must still exit 0; stderr=${r.stderr}`);
    ok(r.stdout.includes("feature.txt"), `stdout must name the blocking path: ${r.stdout}`);
    ok(/behind/i.test(r.stdout), `stdout must say the checkout is behind: ${r.stdout}`);
    ok(!existsSync(marker), "smoke must not run when the checkout does not hold the merge");

    const originSha = git(bare, "rev-parse", "master");
    ok(originSha !== sharedBefore, "origin must hold the squash");
    equal(git(repo, "rev-parse", "master"), sharedBefore, "the shared checkout must not move");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// A25 — a guard that reports no paths must still say what refused. Guard 1 (the
// shared checkout is on another branch) blocks on no file at all, and
// "(blocking path(s): unknown)" told the operator nothing.
test("A25: a refusal with no blocking path names the guard's reason", () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    makeBaseRepo(repo);
    seedRows(home, repo, ["feat-x"]);
    git(repo, "checkout", "-b", "other");

    const r = runMerge(repo, home, "autonomous/feat-x");

    equal(r.status, 0, `a refused land must exit 0; stderr=${r.stderr}`);
    ok(/shared checkout is on 'other', not 'master'/.test(r.stdout),
      `the refusal must carry guard 1's reason: ${r.stdout}`);
    ok(!r.stdout.includes("(unknown)"), `no placeholder may stand in for the reason: ${r.stdout}`);

    const land = runLandOnly(repo, home);

    equal(land.status, 0, `land-only must exit 0; stderr=${land.stderr}`);
    ok(/shared checkout is on 'other', not 'master'/.test(land.stdout),
      `land-only's refusal must carry the reason too: ${land.stdout}`);
    ok(!land.stdout.includes("(unknown)"), `land-only must not print a placeholder: ${land.stdout}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── A14 — no origin: park on refusal, land on resume ─────────────────────────

test("A14: with no origin a refused land parks the squash, and a land-only run lands it", () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    makeBaseRepo(repo);
    seedRows(home, repo, ["feat-x"]);
    writeFileSync(join(repo, "feature.txt"), "draft\n", "utf8");
    const sharedBefore = git(repo, "rev-parse", "master");

    const r = runMerge(repo, home, "autonomous/feat-x");

    equal(r.status, 0, `a refused land must exit 0; stderr=${r.stderr}`);
    const parked = git(repo, "rev-parse", "--verify", "--quiet", "refs/merge/master");
    ok(parked, "the squash must be parked at refs/merge/master");
    equal(git(repo, "rev-parse", "master"), sharedBefore, "the shared checkout must not move");

    rmSync(join(repo, "feature.txt"), { force: true });
    const resume = spawnSync(process.execPath, [
      MERGE_MJS, "--land-only", "--project-dir", repo, "--target-branch", "master", "--skip-smoke",
    ], { env: homeEnv(home), encoding: "utf8", timeout: 120_000 });

    equal(resume.status, 0, `land-only must exit 0; stderr=${resume.stderr}`);
    equal(git(repo, "rev-parse", "master"), parked, "land-only must fast-forward to the parked sha");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── A20 — a park is landed through origin, never dropped on a stale tip ─────
//
// After a failed push, origin/<target> still exists at the pre-merge tip. A
// land-only that picks that ref "lands" a no-op and then deletes the park,
// destroying the only reference to the squash.

test("A20: land-only prefers the parked squash, pushes it, and drops the park only once origin has it", () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    makeBaseRepo(repo);
    const bare = addOrigin(tmp, repo);
    seedRows(home, repo, ["feat-x"]);
    const sharedBefore = git(repo, "rev-parse", "master");

    // An unreachable origin makes the push fail and the squash get parked.
    git(repo, "remote", "set-url", "origin", join(tmp, "unreachable.git"));
    const failed = runMerge(repo, home, "autonomous/feat-x");
    equal(failed.status, 7, `a failed push must exit 7; stderr=${failed.stderr}`);
    const parked = parkedSha(repo);
    ok(parked, `the squash must be parked; stdout=${failed.stdout} stderr=${failed.stderr}`);
    equal(git(bare, "rev-parse", "master"), sharedBefore,
      "a failed push must leave origin at the pre-merge tip");

    // Origin still cannot take it: the park must survive and nothing may land.
    const stillDown = runLandOnly(repo, home);
    ok(stillDown.status !== 0, `an unreachable origin must not read as landed; stdout=${stillDown.stdout}`);
    equal(parkedSha(repo), parked, "the park must survive while origin does not hold it");
    equal(git(repo, "rev-parse", "master"), sharedBefore, "the shared checkout must not move");

    // Origin is back: the parked sha is pushed, then landed, and only then dropped.
    git(repo, "remote", "set-url", "origin", bare);
    const resumed = runLandOnly(repo, home);

    equal(resumed.status, 0, `land-only must exit 0; stdout=${resumed.stdout} stderr=${resumed.stderr}`);
    equal(git(bare, "rev-parse", "master"), parked, "origin must hold the parked squash");
    equal(git(repo, "rev-parse", "master"), parked, "the shared checkout must land on the parked sha");
    equal(parkedSha(repo), null, "the park must be gone once origin holds it");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("A20b: a land-only run with nothing to land touches no ref, including a park", () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    makeBaseRepo(repo);
    seedRows(home, repo, ["feat-x"]);
    const head = git(repo, "rev-parse", "master");
    git(repo, "update-ref", "refs/merge/master", head);

    const r = runLandOnly(repo, home);

    equal(r.status, 0, `a no-op land must exit 0; stderr=${r.stderr}`);
    ok(/nothing to land/i.test(r.stdout), `the run must say there is nothing to land: ${r.stdout}`);
    equal(parkedSha(repo), head, "a no-op land must never delete the park");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// A23 — the worktree HEAD at an abort is not always a squash. `--skip-testing`
// commits the plan rewrite in step 2, so a squash that then fails leaves a
// plan-only commit as HEAD; parking it would make the next --land-only land a
// plan edit in place of the merge.
test("A23: an abort before the squash parks nothing", () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    const plan = "# feat\n\n## Goal\n\nLand it.\n\n## Definition of Done\n\n"
      + "- [ ] behaviour (needs testing)\n\n## Current Status\n\n- in progress\n";
    makeBaseRepo(repo, { plan });
    seedRows(home, repo, ["feat-x"]);
    // Conflict the squash: master also creates feature.txt, with other content.
    writeFileSync(join(repo, "feature.txt"), "master side\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "master takes feature.txt");

    const r = runMerge(repo, home, "autonomous/feat-x", ["--skip-testing"]);

    ok(r.status !== 0, `a conflicting squash must fail; stdout=${r.stdout}`);
    ok(/autonomous\/feat-x/.test(r.stderr), `the failure must name the branch: ${r.stderr}`);
    equal(parkedSha(repo), null, "the plan-only rewrite must not be parked as the merge");
    equal(worktreeCount(repo), 1, "the merge worktree is removed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── A15 — mixed invocation: hook branch then local branch, one push ──────────

test("A15: a hook-merged branch and a locally squash-merged branch both reach origin", () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    makeBaseRepo(repo, { features: ["feat-one", "feat-two"] });
    const bare = addOrigin(tmp, repo);
    seedRows(home, repo, ["feat-one", "feat-two"]);
    const hook = writeHook(home, "hook-merge", [
      "import { execFileSync } from 'node:child_process';",
      "const run = (...a) => execFileSync('git', a, { stdio: 'inherit' });",
      "run('merge', '--squash', process.env.PIPELINE_BRANCH);",
      "run('commit', '-m', `hook merge ${process.env.PIPELINE_BRANCH}`);",
      "run('push', 'origin', `HEAD:refs/heads/${process.env.PIPELINE_TARGET_BRANCH}`);",
    ].join("\n") + "\n");
    writeConfig(home, { hooks: { on_merge: hook } });

    const r = runMerge(repo, home, "autonomous/feat-one,autonomous/feat-two");

    equal(r.status, 0, `mixed merge must exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
    const tree = git(bare, "ls-tree", "-r", "--name-only", "master");
    ok(tree.includes("feat-one.txt"), `origin must hold the hook branch's change: ${tree}`);
    ok(tree.includes("feat-two.txt"), `origin must hold the local branch's change: ${tree}`);
    equal(git(repo, "rev-parse", "master"), git(bare, "rev-parse", "master"),
      "the shared checkout must land on the pushed sha");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── A16 — the on_merge hook runs in the merge worktree ───────────────────────

test("A16: the on_merge hook's cwd is the merge worktree printed on stdout", () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    makeBaseRepo(repo);
    seedRows(home, repo, ["feat-x"]);
    const cwdMarker = join(home, "hook-cwd.txt");
    const hook = writeHook(home, "cwd-hook", [
      "import { writeFileSync } from 'node:fs';",
      "import { execFileSync } from 'node:child_process';",
      `writeFileSync(${JSON.stringify(cwdMarker)}, process.cwd(), 'utf8');`,
      "const run = (...a) => execFileSync('git', a, { stdio: 'inherit' });",
      "run('merge', '--squash', process.env.PIPELINE_BRANCH);",
      "run('commit', '-m', `hook merge ${process.env.PIPELINE_BRANCH}`);",
    ].join("\n") + "\n");
    writeConfig(home, { hooks: { on_merge: hook } });

    const r = runMerge(repo, home, "autonomous/feat-x");

    equal(r.status, 0, `merge must exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
    const wtPath = mergeWorktreeFromStdout(r.stdout);
    ok(wtPath, `the merge worktree path must be printed: ${r.stdout}`);
    equal(resolve(readFileSync(cwdMarker, "utf8")), resolve(wtPath),
      "the hook must run with cwd = the merge worktree");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── A17 — an existing path is refused, never reclaimed ───────────────────────

test("A17: an existing merge-worktree path is refused and left untouched", () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    makeBaseRepo(repo);
    seedRows(home, repo, ["feat-x"]);
    const slug = "merge_fixed-1";
    const path = featureWorktreePath({ project: basename(repo), projectRoot: repo, feature: slug });
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "live-run.txt"), "someone else's work\n", "utf8");

    const r = runMerge(repo, home, "autonomous/feat-x", ["--session-slug", slug]);

    ok(r.status !== 0, `an existing path must refuse; stdout=${r.stdout}`);
    ok(/BLOCKER/.test(r.stderr), `refusal must be a BLOCKER: ${r.stderr}`);
    ok(r.stderr.includes(path), `the BLOCKER must name the path: ${r.stderr}`);
    equal(readFileSync(join(path, "live-run.txt"), "utf8"), "someone else's work\n",
      "the existing directory must be untouched");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
