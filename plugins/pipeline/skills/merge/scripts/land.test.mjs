// land.test.mjs — the four guards on the shared-checkout fast-forward.
//
// landTarget is the only code in /merge that mutates the target checkout. Each
// guard is pinned by the input that makes it refuse, so deleting one turns its
// row red. The false-positive guard (A5) keeps the land from being made
// gratuitously strict: a non-overlapping foreign edit must survive.
import "../../../tests/helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { landTarget } from "./land.mjs";

function git(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo({ target = "main" } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "land-test-"));
  const repo = join(tmp, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "--initial-branch=" + target);
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "init\n", "utf8");
  writeFileSync(join(repo, "src", "a.txt"), "a\n", "utf8");
  writeFileSync(join(repo, "a.md"), "movable\n", "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "base");
  return { tmp, repo, target };
}

// Commit `fn`'s work on a throwaway branch and return the resulting sha,
// leaving the shared checkout on `target`.
function landingSha(repo, target, fn, branch = "landing") {
  git(repo, "checkout", "-b", branch);
  fn();
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "land this");
  const sha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", target);
  return sha;
}

function logs() {
  const out = [];
  const errLines = [];
  return { log: (m) => out.push(m), err: (m) => errLines.push(m), out, errLines };
}

// A5 — false-positive guard: a foreign edit to a file the land does not touch
// survives the fast-forward byte-identical.
test("landTarget: fast-forwards over a non-overlapping unstaged foreign edit", () => {
  const { tmp, repo, target } = makeRepo();
  try {
    const sha = landingSha(repo, target, () => writeFileSync(join(repo, "src", "a.txt"), "a2\n", "utf8"));
    writeFileSync(join(repo, "README.md"), "foreign edit\n", "utf8");

    const l = logs();
    const res = landTarget(repo, target, sha, l);

    equal(res.landed, true, `expected a land, got ${JSON.stringify(res)} err=${l.errLines.join("; ")}`);
    equal(git(repo, "rev-parse", target), sha, "target holds the landed sha");
    equal(readFileSync(join(repo, "README.md"), "utf8"), "foreign edit\n", "README untouched");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// A6 — an unstaged edit to a file the sha touches: refuse, name the path, move nothing.
test("landTarget: refuses an overlapping unstaged edit and names the path", () => {
  const { tmp, repo, target } = makeRepo();
  try {
    const sha = landingSha(repo, target, () => writeFileSync(join(repo, "src", "a.txt"), "a2\n", "utf8"));
    const before = git(repo, "rev-parse", target);
    writeFileSync(join(repo, "src", "a.txt"), "foreign edit\n", "utf8");

    const l = logs();
    const res = landTarget(repo, target, sha, l);

    equal(res.landed, false, "an overlapping edit must refuse");
    ok(String(res.reason).includes("src/a.txt") || res.paths.includes("src/a.txt"),
      `reason or paths must name the blocking path; got reason=${res.reason} paths=${res.paths}`);
    equal(git(repo, "rev-parse", target), before, "target ref must not move");
    equal(readFileSync(join(repo, "src", "a.txt"), "utf8"), "foreign edit\n", "file intact");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// A7 — HEAD is not the target branch: refuse; the checked-out branch must not move.
test("landTarget: refuses when the shared checkout is not on the target branch", () => {
  const { tmp, repo, target } = makeRepo();
  try {
    const sha = landingSha(repo, target, () => writeFileSync(join(repo, "src", "a.txt"), "a2\n", "utf8"));
    git(repo, "checkout", "-b", "other");
    const mainBefore = git(repo, "rev-parse", target);
    const otherBefore = git(repo, "rev-parse", "other");

    const l = logs();
    const res = landTarget(repo, target, sha, l);

    equal(res.landed, false, "a checkout on another branch must refuse");
    equal(git(repo, "rev-parse", target), mainBefore, "target must not move");
    equal(git(repo, "rev-parse", "other"), otherBefore, "the checked-out branch must not move");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// A7b — guard 2: the sha is not a descendant of what the target holds, so the
// "fast-forward" would be a merge. paths is empty: no file is blocking it.
test("landTarget: refuses a sha that is not a descendant of the target", () => {
  const { tmp, repo, target } = makeRepo();
  try {
    const sha = landingSha(repo, target, () => writeFileSync(join(repo, "src", "a.txt"), "a2\n", "utf8"));
    // Move the target on, so the landing sha and the target have diverged.
    writeFileSync(join(repo, "target.txt"), "moved\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "target moves on");
    const before = git(repo, "rev-parse", target);

    const l = logs();
    const res = landTarget(repo, target, sha, l);

    equal(res.landed, false, "a non-descendant sha must refuse");
    // Guard 2's own refusal, not guard 4's: `--ff-only` also refuses a
    // non-descendant, so `landed === false` alone does not pin this guard.
    ok(/not a descendant/i.test(String(res.reason)),
      `guard 2 must be the one that refuses: ${res.reason}`);
    deepEqual(res.paths, [], "guard 2 has no blocking file to report");
    equal(git(repo, "rev-parse", target), before, "target ref must not move");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// A8.1 — a staged edit to a file the sha also changes.
test("landTarget: refuses a staged overlap and leaves the staged change intact", () => {
  const { tmp, repo, target } = makeRepo();
  try {
    const sha = landingSha(repo, target, () => writeFileSync(join(repo, "src", "a.txt"), "a2\n", "utf8"));
    const before = git(repo, "rev-parse", target);
    writeFileSync(join(repo, "src", "a.txt"), "staged edit\n", "utf8");
    git(repo, "add", "src/a.txt");

    const l = logs();
    const res = landTarget(repo, target, sha, l);

    equal(res.landed, false, "a staged overlap must refuse");
    ok(res.paths.includes("src/a.txt"), `paths must name the staged overlap: ${res.paths}`);
    equal(git(repo, "rev-parse", target), before, "target ref must not move");
    equal(git(repo, "status", "--porcelain", "--", "src/a.txt"), "M  src/a.txt", "staged change intact");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// A8.2 — the sha renames a.md -> complete/a.md while the shared checkout has
// a.md staged. Without --no-renames the diff lists only the destination and
// the overlap on the source path goes unseen.
test("landTarget: refuses a staged overlap on a rename's source path", () => {
  const { tmp, repo, target } = makeRepo();
  try {
    const sha = landingSha(repo, target, () => {
      mkdirSync(join(repo, "complete"), { recursive: true });
      git(repo, "mv", "a.md", "complete/a.md");
    });
    const before = git(repo, "rev-parse", target);
    writeFileSync(join(repo, "a.md"), "staged edit\n", "utf8");
    git(repo, "add", "a.md");

    const l = logs();
    const res = landTarget(repo, target, sha, l);

    equal(res.landed, false, "a staged rename source must refuse");
    ok(res.paths.includes("a.md"), `paths must name the rename source: ${res.paths}`);
    equal(git(repo, "rev-parse", target), before, "target ref must not move");
    equal(git(repo, "status", "--porcelain", "--", "a.md"), "M  a.md", "staged change intact");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
