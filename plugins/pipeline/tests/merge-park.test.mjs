// merge-park.test.mjs — a squash parked at refs/merge/<target> and the
// land-only resume that lands it. Split from merge-worktree.test.mjs: a park is
// the only ref holding a squash once the worktree is gone, so the rows that
// guard it read as their own family.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  MERGE_MJS, git, makeRepoDir, makeBaseRepo, addOrigin, makeHome, homeEnv,
  seedRows, runMerge, runLandOnly, parkedSha, worktreeCount,
} from "./helpers/merge-fixtures.mjs";

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