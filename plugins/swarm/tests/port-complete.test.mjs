// Row 4 of the taken-lanes test plan: a port is recorded only once git has finished it.
// Every in-progress state git can leave behind is built for real, then aborted.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok, throws } from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { portInProgress } from "../src/port-complete.mjs";
import { portFixture, git, must, writeCommit } from "./helpers/port-fixture.mjs";

// feat and main rewrote the same line, so a pick, a merge, a revert and a rebase all
// stop mid-flight in the porting worktree.
function diverged() {
  const f = portFixture();
  const port = f.porting();
  writeCommit(port, "a.txt", "feat\n", "feat");
  writeCommit(f.repo, "a.txt", "main\n", "mainchange");
  writeCommit(f.repo, "b.txt", "x\n", "second");
  return {
    f,
    port,
    mainChange: must(["rev-parse", "main~1"], f.repo),
    second: must(["rev-parse", "main"], f.repo),
  };
}

const marker = (tree, name) => resolve(tree, must(["rev-parse", "--git-path", name], tree));

// The command must stop, and the state it leaves must read in progress.
function stopped(f, tree, args) {
  equal(git(args, tree).status, 1, `${args.join(" ")} must stop on a conflict`);
  equal(portInProgress(tree, f.git), true, args.join(" "));
}

test("row 4: every in-progress state reads in progress, and each abort clears it", () => {
  const { f, port, mainChange, second } = diverged();
  try {
    equal(portInProgress(port, f.git), false, "a clean porting checkout");

    stopped(f, port, ["merge", "main"]);
    ok(existsSync(marker(port, "MERGE_HEAD")), "MERGE_HEAD");
    must(["merge", "--abort"], port);
    equal(portInProgress(port, f.git), false, "a merge abort clears it");

    stopped(f, port, ["cherry-pick", mainChange]);
    ok(existsSync(marker(port, "CHERRY_PICK_HEAD")), "CHERRY_PICK_HEAD");
    must(["cherry-pick", "--abort"], port);
    equal(portInProgress(port, f.git), false, "a pick abort clears it");

    stopped(f, port, ["revert", "--no-edit", mainChange]);
    ok(existsSync(marker(port, "REVERT_HEAD")), "REVERT_HEAD");
    must(["revert", "--abort"], port);

    stopped(f, port, ["rebase", "main"]);
    ok(existsSync(marker(port, "rebase-merge")), "rebase-merge");
    must(["rebase", "--abort"], port);

    stopped(f, port, ["rebase", "--apply", "main"]);
    ok(existsSync(marker(port, "rebase-apply")), "rebase-apply");
    must(["rebase", "--abort"], port);
    equal(portInProgress(port, f.git), false, "a rebase abort clears it");

    // A multi-commit pick queues a sequencer. `--quit` drops the markers but leaves the
    // index unmerged, which the last check must catch on its own.
    stopped(f, port, ["cherry-pick", mainChange, second]);
    ok(existsSync(marker(port, "sequencer")), "a multi-commit pick queues a sequencer");
    ok(existsSync(marker(port, "CHERRY_PICK_HEAD")), "and a pick head");
    must(["cherry-pick", "--quit"], port);
    ok(!existsSync(marker(port, "sequencer")), "--quit drops the sequencer");
    ok(!existsSync(marker(port, "CHERRY_PICK_HEAD")), "--quit drops CHERRY_PICK_HEAD");
    ok(must(["diff", "--name-only", "--diff-filter=U"], port) !== "", "the index is still unmerged");
    equal(portInProgress(port, f.git), true, "an unmerged index alone is in progress");
  } finally { f.cleanup(); }
});

test("row 4: markers resolve through git's own path, not `<tree>/.git`", () => {
  const f = portFixture();
  const port = f.porting();
  try {
    // A linked worktree's `.git` is a file, so only `--git-path` finds its markers.
    const resolved = marker(port, "CHERRY_PICK_HEAD");
    ok(!resolved.startsWith(join(port, ".git") + sep), `a linked worktree keeps markers outside its tree: ${resolved}`);
    ok(resolved.startsWith(resolve(f.repo, ".git") + sep), resolved);

    equal(portInProgress(port, f.git), false, "clean before the marker");
    writeFileSync(resolved, `${must(["rev-parse", "HEAD"], port)}\n`);
    equal(portInProgress(port, f.git), true, "the admin-dir marker is seen");
    rmSync(resolved);
    equal(portInProgress(port, f.git), false, "and only that marker counts");

    // The main worktree reports `.git/<name>` relative to the tree.
    const relative = must(["rev-parse", "--git-path", "MERGE_HEAD"], f.repo);
    ok(!/^([A-Za-z]:[\\/]|[\\/])/.test(relative), `the main worktree's path is relative: ${relative}`);
    const abs = resolve(f.repo, relative);
    writeFileSync(abs, `${must(["rev-parse", "HEAD"], f.repo)}\n`);
    equal(portInProgress(f.repo, f.git), true, "a relative marker resolves against the tree");
    rmSync(abs);
    equal(portInProgress(f.repo, f.git), false);
  } finally { f.cleanup(); }
});

test("row 4: a git that cannot answer reads in progress", () => {
  const f = portFixture();
  try {
    const failing = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
    equal(portInProgress(f.repo, failing), true, "a git failure records nothing");

    const throwing = () => { throw new Error("spawn failed"); };
    equal(portInProgress(f.repo, throwing), true, "a thrown git call records nothing");

    // Marker probes answer; the unmerged probe fails. Still no proof of a finished port.
    const mixed = (args) => (args.includes("--diff-filter=U")
      ? { status: 128, stdout: "", stderr: "fatal" }
      : { status: 0, stdout: ".git/CHERRY_PICK_HEAD", stderr: "" });
    equal(portInProgress(f.repo, mixed), true, "a failed unmerged probe is no proof");

    throws(() => portInProgress(f.repo), TypeError, "the git runner is required");
  } finally { f.cleanup(); }
});
