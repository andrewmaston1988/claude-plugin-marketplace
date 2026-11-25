import "./helpers/isolate-home.mjs"; import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { prepareIsolation, integrate } from "../src/worktree.mjs";
import { initRepo, cleanup, commitAll, CFG, ADD } from "./helpers/worktree-fixtures.mjs";

test("integrate merges sibling branches into the target tree", async () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-int-"));
  try {
    const base = await prepareIsolation({ id: "helper", originalCwd: repo, worktreeName: "feat" }, CFG, results, ADD(repo));
    writeFileSync(join(base.path, "helper.txt"), "helper\n");
    commitAll(base.path, "helper");

    for (const id of ["x", "y"]) {
      const wt = await prepareIsolation({ id, originalCwd: repo, worktreeName: id }, CFG, results, ADD(repo));
      writeFileSync(join(wt.path, `${id}.txt`), `${id} work\n`);
      commitAll(wt.path, `${id} work`);
    }

    const out = await integrate(
      { id: "join", worktreeName: "feat", sources: ["swarm/x", "swarm/y"] }, CFG, results, { repo, ...ADD(repo) });

    equal(out.conflicts.length, 0, "disjoint files merge cleanly");
    ok(existsSync(join(out.path, "x.txt")) && existsSync(join(out.path, "y.txt")),
      "both siblings' work is present in the target tree");
  } finally { cleanup(repo, results); }
});

test("integrate leaves conflict markers in place and reports the paths", async () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-int2-"));
  try {
    // The shared file is on the BASE so the first source merges cleanly and the
    // conflict genuinely lands on the last.
    writeFileSync(join(repo, "shared.txt"), "original\n");
    commitAll(repo, "shared base");
    await prepareIsolation({ id: "feat", originalCwd: repo, worktreeName: "feat" }, CFG, results, ADD(repo));

    for (const [id, text] of [["x", "x version\n"], ["y", "y version\n"]]) {
      const wt = await prepareIsolation({ id, originalCwd: repo, worktreeName: id }, CFG, results, ADD(repo));
      writeFileSync(join(wt.path, "shared.txt"), text);
      commitAll(wt.path, `${id} edits shared`);
    }

    const out = await integrate(
      { id: "join", worktreeName: "feat", sources: ["swarm/x", "swarm/y"] }, CFG, results, { repo, ...ADD(repo) });

    deepEqual(out.conflicts, ["shared.txt"], "the conflicting path is reported");
    const body = readFileSync(join(out.path, "shared.txt"), "utf8");
    ok(body.includes("<<<<<<<") && body.includes(">>>>>>>"),
      "conflict markers are left for the next leaf to resolve");
    ok(out.merged.includes("swarm/x"), "the clean merge before the conflict still landed");
    deepEqual(out.pending, [], "a conflict on the last source leaves nothing pending");
  } finally { cleanup(repo, results); }
});

// A conflicting middle source: every later merge would fail against the merge still
// in progress, so the sequence stops there and only genuine ancestry is reported.
async function threeSourceTrees(repo, results) {
  writeFileSync(join(repo, "shared.txt"), "original\n");
  commitAll(repo, "shared base");
  await prepareIsolation({ id: "feat", originalCwd: repo, worktreeName: "feat" }, CFG, results, ADD(repo));
  for (const [id, file, text] of [["x", "shared.txt", "x version\n"], ["y", "shared.txt", "y version\n"], ["z", "other.txt", "z work\n"]]) {
    const wt = await prepareIsolation({ id, originalCwd: repo, worktreeName: id }, CFG, results, ADD(repo));
    writeFileSync(join(wt.path, file), text);
    commitAll(wt.path, `${id} edits ${file}`);
  }
}

const isAncestor = (src, cwd) =>
  spawnSync("git", ["merge-base", "--is-ancestor", src, "HEAD"], { cwd, windowsHide: true }).status === 0;

test("integrate stops at its first conflict and reports only what merged", async () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-int3-"));
  try {
    await threeSourceTrees(repo, results);

    const out = await integrate(
      { id: "join", worktreeName: "feat", sources: ["swarm/x", "swarm/y", "swarm/z"] }, CFG, results, { repo, ...ADD(repo) });

    deepEqual(out.merged, ["swarm/x"], "only the source whose work is in the tree is merged");
    deepEqual(out.conflict, { branch: "swarm/y", paths: ["shared.txt"] }, "the conflict names its branch and paths");
    deepEqual(out.pending, ["swarm/z"], "the sources after the conflict are still to merge");
    ok(!existsSync(join(out.path, "other.txt")), "a source after the conflict never merged");
  } finally { cleanup(repo, results); }
});

test("integrate's merged list is ancestry, not the input list", async () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-int4-"));
  try {
    await threeSourceTrees(repo, results);

    const out = await integrate(
      { id: "join", worktreeName: "feat", sources: ["swarm/x", "swarm/y", "swarm/z"] }, CFG, results, { repo, ...ADD(repo) });

    for (const src of out.merged) ok(isAncestor(src, out.path), `${src} is reported merged and must be an ancestor of the tree's HEAD`);
    ok(!isAncestor("swarm/y", out.path), "the conflicted branch is not an ancestor");
    ok(!isAncestor("swarm/z", out.path), "a pending branch is not an ancestor");
  } finally { cleanup(repo, results); }
});

test("a clean integrate reports every source merged and nothing pending", async () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-int5-"));
  try {
    await prepareIsolation({ id: "feat", originalCwd: repo, worktreeName: "feat" }, CFG, results, ADD(repo));
    for (const id of ["x", "y", "z"]) {
      const wt = await prepareIsolation({ id, originalCwd: repo, worktreeName: id }, CFG, results, ADD(repo));
      writeFileSync(join(wt.path, `${id}.txt`), `${id} work\n`);
      commitAll(wt.path, `${id} work`);
    }

    const out = await integrate(
      { id: "join", worktreeName: "feat", sources: ["swarm/x", "swarm/y", "swarm/z"] }, CFG, results, { repo, ...ADD(repo) });

    deepEqual(out.merged, ["swarm/x", "swarm/y", "swarm/z"]);
    equal(out.conflict, null, "no conflict is reported");
    deepEqual(out.pending, [], "nothing is left to merge");
    deepEqual(out.conflicts, []);
  } finally { cleanup(repo, results); }
});

test("integrate reports an empty merged when its first source conflicts", async () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-int6-"));
  try {
    writeFileSync(join(repo, "shared.txt"), "original\n");
    commitAll(repo, "shared base");
    const feat = await prepareIsolation({ id: "feat", originalCwd: repo, worktreeName: "feat" }, CFG, results, ADD(repo));
    writeFileSync(join(feat.path, "shared.txt"), "feat version\n");
    commitAll(feat.path, "feat edits shared");
    for (const [id, file, text] of [["x", "shared.txt", "x version\n"], ["y", "other.txt", "y work\n"]]) {
      const wt = await prepareIsolation({ id, originalCwd: repo, worktreeName: id }, CFG, results, ADD(repo));
      writeFileSync(join(wt.path, file), text);
      commitAll(wt.path, `${id} edits ${file}`);
    }

    const out = await integrate(
      { id: "join", worktreeName: "feat", sources: ["swarm/x", "swarm/y"] }, CFG, results, { repo, ...ADD(repo) });

    deepEqual(out.merged, [], "a first-source conflict merges nothing");
    equal(out.conflict.branch, "swarm/x");
    deepEqual(out.pending, ["swarm/y"]);
  } finally { cleanup(repo, results); }
});

test("integrate refuses a kept tree holding an unfinished merge", async () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-int7-"));
  try {
    writeFileSync(join(repo, "shared.txt"), "original\n");
    commitAll(repo, "shared base");
    await prepareIsolation({ id: "feat", originalCwd: repo, worktreeName: "feat" }, CFG, results, ADD(repo));
    for (const [id, text] of [["x", "x version\n"], ["y", "y version\n"]]) {
      const wt = await prepareIsolation({ id, originalCwd: repo, worktreeName: id }, CFG, results, ADD(repo));
      writeFileSync(join(wt.path, "shared.txt"), text);
      commitAll(wt.path, `${id} edits shared`);
    }
    const task = { id: "join", worktreeName: "feat", sources: ["swarm/x", "swarm/y"] };
    const first = await integrate(task, CFG, results, { repo, ...ADD(repo) });
    equal(first.conflict.branch, "swarm/y", "precondition: the first attempt stops mid-merge");

    let threw = null;
    try { await integrate(task, CFG, results, { repo, ...ADD(repo) }); } catch (e) { threw = e; }
    ok(threw, "re-entering a tree mid-merge must throw");
    ok(threw.message.includes(first.path), `the error names the tree: ${threw.message}`);
    ok(/unfinished merge/.test(threw.message), `the error says the merge is unfinished: ${threw.message}`);
  } finally { cleanup(repo, results); }
});

test("integrate fails when git cannot answer whether a source merged", async () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-int8-"));
  try {
    await prepareIsolation({ id: "feat", originalCwd: repo, worktreeName: "feat" }, CFG, results, ADD(repo));
    for (const id of ["x", "y"]) {
      const wt = await prepareIsolation({ id, originalCwd: repo, worktreeName: id }, CFG, results, ADD(repo));
      writeFileSync(join(wt.path, `${id}.txt`), `${id} work\n`);
      commitAll(wt.path, `${id} work`);
    }
    const realGit = (args, cwd, opts) => {
      const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: opts?.timeout });
      return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
    };
    const badGit = (args, cwd, opts) => (args[0] === "merge-base"
      ? { status: 128, stdout: "", stderr: "fatal: ambiguous argument" }
      : realGit(args, cwd, opts));

    let threw = null;
    try {
      await integrate(
        { id: "join", worktreeName: "feat", sources: ["swarm/x", "swarm/y"] }, CFG, results,
        { repo, ...ADD(repo), _git: badGit });
    } catch (e) { threw = e; }
    ok(threw, "an unanswerable ancestry check must throw, not silently drop the source");
    ok(threw.message.includes("swarm/x"), `the error names the source it could not check: ${threw.message}`);
  } finally { cleanup(repo, results); }
});

test("integrate reports merged from ancestry, not from a merge that exited 0", async () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-int9-"));
  try {
    await prepareIsolation({ id: "feat", originalCwd: repo, worktreeName: "feat" }, CFG, results, ADD(repo));
    for (const id of ["x", "y"]) {
      const wt = await prepareIsolation({ id, originalCwd: repo, worktreeName: id }, CFG, results, ADD(repo));
      writeFileSync(join(wt.path, `${id}.txt`), `${id} work\n`);
      commitAll(wt.path, `${id} work`);
    }
    // Both merges succeed; only the ancestry verdict is forced, so the list must follow it.
    const realGit = (args, cwd, opts) => {
      const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: opts?.timeout });
      return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
    };
    const deniesX = (args, cwd, opts) => (args[0] === "merge-base" && args.includes("swarm/x")
      ? { status: 1, stdout: "", stderr: "" }
      : realGit(args, cwd, opts));

    const out = await integrate(
      { id: "join", worktreeName: "feat", sources: ["swarm/x", "swarm/y"] }, CFG, results,
      { repo, ...ADD(repo), _git: deniesX });

    ok(existsSync(join(out.path, "x.txt")), "precondition: swarm/x did merge into the tree");
    deepEqual(out.merged, ["swarm/y"], "a source git's ancestry check denies is never reported merged");
  } finally { cleanup(repo, results); }
});
