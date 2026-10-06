// The run's base commits: captured once per repo at dispatch, persisted so a
// resume re-enters the same base, and recaptured only on --force.
import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { BASES_FILE, baseFor, captureBases } from "../src/run-bases.mjs";
import { runPlan } from "../src/scheduler.mjs";
import { checkoutToplevel } from "../src/worktree.mjs";
import {
  CFG, commitAllInRepo, fakeSpawnFactory, gitInRepo, initGitRepo, integrateLeaf,
  makeIo, plan, tmp,
} from "./helpers/scheduler-fixtures.mjs";

const heads = (repo) => spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", windowsHide: true }).stdout.trim();

const writer = (id, repo, over = {}) => ({ id, originalCwd: repo, cwd: repo, worktreeName: id, ...over });

test("captureBases reads HEAD once per repo and persists it", () => {
  const repo = initGitRepo();
  const dir = tmp();
  try {
    const bases = captureBases([writer("a", repo), writer("b", repo)], { resultsDir: dir });
    const top = checkoutToplevel(repo);
    equal(bases.get(top), heads(repo), "one entry per repo, holding its HEAD");
    equal(bases.size, 1, "two tasks in one repo share one base");
    deepEqual(JSON.parse(readFileSync(join(dir, BASES_FILE), "utf8")), { [top]: heads(repo) });
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("a resume reuses the persisted base; --force recaptures", () => {
  const repo = initGitRepo();
  const dir = tmp();
  try {
    const first = captureBases([writer("a", repo)], { resultsDir: dir });
    const top = checkoutToplevel(repo);
    const dispatch = first.get(top);

    writeFileSync(join(repo, "later.txt"), "moved\n");
    commitAllInRepo(repo, "moved on");
    ok(heads(repo) !== dispatch, "precondition: HEAD moved after capture");

    equal(captureBases([writer("a", repo)], { resultsDir: dir }).get(top), dispatch,
      "a resume must re-enter trees on the base the run was dispatched from");
    equal(captureBases([writer("a", repo)], { resultsDir: dir }, {}, { force: true }).get(top), heads(repo),
      "--force is a cold redo and recaptures");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("a malformed bases.json fails the run loudly, naming the file", () => {
  const repo = initGitRepo();
  const dir = tmp();
  try {
    writeFileSync(join(dir, BASES_FILE), JSON.stringify({ "/some/repo": "not-a-sha" }));
    let error;
    try { captureBases([writer("a", repo)], { resultsDir: dir }); } catch (e) { error = e; }
    ok(error, "a corrupted base file must abort rather than silently recapture");
    ok(error.message.includes(BASES_FILE), error.message);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("captureBases skips a task that isolates nothing, and baseFor throws for a repo never captured", () => {
  const repoA = initGitRepo();
  const repoB = initGitRepo();
  const dir = tmp();
  try {
    const bases = captureBases(
      [{ id: "reader", originalCwd: repoA, cwd: repoA, allowedTools: "Read,Grep" }, writer("a", repoA)],
      { resultsDir: dir });
    equal(bases.size, 1, "a leaf with no tree pins nothing");
    equal(baseFor(bases, repoA), heads(repoA));
    let error;
    try { baseFor(bases, repoB); } catch (e) { error = e; }
    ok(error, "a repo the run never captured has no base");
    ok(error.message.includes(checkoutToplevel(repoB)), `the error must name the repo: ${error.message}`);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repoA, { recursive: true, force: true }); rmSync(repoB, { recursive: true, force: true }); }
});

// The defect #2 case end to end: a leaf that waits on `after` while the live
// checkout moves must still be cut from the commit the run was dispatched from.
test("a leaf launched after the live checkout moved is still cut from the dispatch commit", async () => {
  const repo = initGitRepo();
  const dir = tmp();
  const dispatch = heads(repo);
  let midRun = null;
  try {
    const spawn = fakeSpawnFactory((call) => {
      if (call.opts.cwd.endsWith("wt-first") && !midRun) {
        // A merge lands on the live checkout while the run is in flight.
        writeFileSync(join(repo, "merged.txt"), "landed mid-run\n");
        commitAllInRepo(repo, "mid-run merge");
        midRun = heads(repo);
      }
      writeFileSync(join(call.opts.cwd, "leaf.txt"), "work\n");
      return { output: "done" };
    });
    const io = makeIo(spawn);
    const p = plan(repo, [
      integrateLeaf("first", { cwd: repo, originalCwd: repo, worktreeName: "first" }),
      integrateLeaf("second", { cwd: repo, originalCwd: repo, worktreeName: "second", after: ["first"] }),
    ], { resultsDir: join(dir, "run"), concurrency: 1 });

    await runPlan(p, CFG, io);

    ok(midRun && midRun !== dispatch, "precondition: the live checkout moved during the run");
    const secondTree = join(p.resultsDir, "wt-second");
    equal(gitInRepo(["rev-parse", "HEAD"], secondTree), dispatch,
      "the second leaf's tree must sit on the dispatch commit, not the checkout's later HEAD");
    equal(spawnSync("git", ["merge-base", "--is-ancestor", midRun, "HEAD"],
      { cwd: secondTree, windowsHide: true }).status, 1,
      "the mid-run merge must not be an ancestor of the second tree");
    ok(existsSync(join(p.resultsDir, BASES_FILE)), "the pinned bases are on disk for a resume");
    ok(/"event":"bases"/.test(readFileSync(join(p.resultsDir, "run.log"), "utf8")),
      "the run logs the bases it pinned");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});
