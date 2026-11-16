// The taken fixture must be the reported shape, not an approximation of it: the lane's
// work was taken, yet every check prune runs still says it was not.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { existsSync } from "node:fs";
import { unlandedCount } from "../src/landed.mjs";
import { git, must, takenFixture } from "./helpers/port-fixture.mjs";

test("the taken fixture is a lane no content check can see as landed", () => {
  const f = takenFixture();
  try {
    // The lane's lines and the review's lines both changed under one merge base: a merge
    // of the two conflicts, which is what stops absorption proving anything.
    const merged = git(["merge-tree", "--write-tree", f.squash, f.lane.tip], f.repo);
    equal(merged.status, 1, `expected a conflict: ${merged.stdout}${merged.stderr}`);

    // git cherry prints `+` for each lane commit: main holds neither commit nor an
    // equivalent patch of its own (the squash carries the review edits).
    const cherry = must(["cherry", "main", f.lane.branch], f.repo);
    deepEqual(cherry.split("\n").map((l) => `${l[0]} ${l.slice(2)}`), f.lane.commits.map((sha) => `+ ${sha}`));
    equal(unlandedCount(f.lane.branch, f.repo, { prefix: "swarm/", gitRunner: f.git, extraBases: [] }), 2);

    // The branch was deleted, and the tip it held was not the lane's own commit.
    equal(git(["rev-parse", "--verify", "--quiet", `refs/heads/${f.branch}`], f.repo).status, 1);
    ok(f.portTip !== f.lane.tip && f.review === f.portTip);
    ok(existsSync(f.lane.path), "the run's own tree is still on disk for prune to measure");
    ok(existsSync(f.runDir), f.runDir);
  } finally { f.cleanup(); }
});
