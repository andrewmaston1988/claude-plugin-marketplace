import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { absorbed, unlandedCount } from "../src/landed.mjs";

const PREFIX = "swarm/";
function git(args, cwd, opts = {}) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", windowsHide: true, input: opts.input });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}
function must(args, cwd) {
  const r = git(args, cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), "swarm-landed-batch-"));
  must(["init", "-q", "-b", "main"], repo);
  writeCommit(repo, "seed.txt", "seed\n", "seed");
  return repo;
}
function writeCommit(repo, file, body, message) {
  writeFileSync(join(repo, file), body);
  must(["add", "."], repo);
  must(["commit", "-qm", message], repo);
}
function squashFixture(repo) {
  must(["checkout", "-q", "-b", "swarm/leaf"], repo);
  writeCommit(repo, "leaf.txt", "leaf\n", "leaf");
  must(["checkout", "-q", "main"], repo);
  must(["merge", "-q", "--squash", "swarm/leaf"], repo);
  must(["commit", "-qm", "squash"], repo);
  writeCommit(repo, "later.txt", "later\n", "later");
}
function recording(delegate = git) {
  const calls = [];
  return { calls, run(args, cwd, opts) { calls.push({ args, input: opts?.input }); return delegate(args, cwd, opts); } };
}

test("L1: 2.39 batches rows and preserves first absorption", () => {
  const repo = initRepo();
  try {
    squashFixture(repo);
    const rec = recording();
    equal(absorbed(must(["rev-parse", "main"], repo), must(["rev-parse", "swarm/leaf"], repo), repo, rec.run), true);
    const batch = rec.calls.filter(({ args }) => args[0] === "merge-tree" && args.includes("--stdin"));
    equal(batch.length, 1);
    equal(batch[0].input.trim().split(/\r?\n/).length, 2);
    ok(batch[0].args.includes("-z"));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("L2: Git 2.38 uses per-commit merge-tree and 2.34 skips absorption", () => {
  const repo = initRepo();
  try {
    squashFixture(repo);
    for (const version of ["2.38.0", "2.34.1"]) {
      const rec = recording((args, cwd, opts) => args[0] === "version"
        ? { status: 0, stdout: `git version ${version}`, stderr: "" }
        : git(args, cwd, opts));
      const result = absorbed(must(["rev-parse", "main"], repo), must(["rev-parse", "swarm/leaf"], repo), repo, rec.run);
      if (version === "2.38.0") { equal(result, true); ok(rec.calls.some(({ args }) => args[0] === "merge-tree")); }
      else { equal(result, false); equal(rec.calls.filter(({ args }) => args[0] === "merge-tree").length, 0); }
      ok(rec.calls.every(({ args }) => !(args[0] === "merge-tree" && args.includes("--stdin"))));
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("L3: malformed or truncated 2.39 batch output returns Infinity", () => {
  const repo = initRepo();
  try {
    squashFixture(repo);
    const rec = recording((args, cwd, opts) => {
      if (args[0] === "version") return { status: 0, stdout: "git version 2.39.0", stderr: "" };
      if (args[0] === "merge-tree" && args.includes("--stdin")) return { status: 0, stdout: "1\0deadbeef", stderr: "" };
      return git(args, cwd, opts);
    });
    equal(unlandedCount("swarm/leaf", repo, { prefix: PREFIX, gitRunner: rec.run, extraBases: [] }), Infinity);
    const failed = recording((args, cwd, opts) => {
      if (args[0] === "version") return { status: 0, stdout: "git version 2.39.0", stderr: "" };
      if (args[0] === "merge-tree" && args.includes("--stdin")) return { status: 2, stdout: ["1", "f".repeat(40), "", "", ""].join("\0"), stderr: "boom" };
      return git(args, cwd, opts);
    });
    equal(unlandedCount("swarm/leaf", repo, { prefix: PREFIX, gitRunner: failed.run, extraBases: [] }), Infinity);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});


test("L1 short-circuit: an absorbed row wins before a malformed later row", () => {
  const repo = initRepo();
  try {
    squashFixture(repo);
    let batchTrees;
    const rec = recording((args, cwd, opts) => {
      if (args[0] === "version") return { status: 0, stdout: "git version 2.39.0", stderr: "" };
      if (args[0] === "rev-parse" && args.length > 2) {
        const result = git(args, cwd, opts);
        batchTrees = result.stdout.trim().split(/\r?\n/);
        return result;
      }
      if (args[0] === "merge-tree" && args.includes("--stdin")) {
        return { status: 2, stdout: ["1", "f".repeat(40), "", "1", batchTrees[1], "", "x", "bad", ""].join("\0"), stderr: "late row failed" };
      }
      return git(args, cwd, opts);
    });
    equal(absorbed(must(["rev-parse", "main"], repo), must(["rev-parse", "swarm/leaf"], repo), repo, rec.run), true);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("L1 mixed rows: conflict, clean miss, then absorbed tree maps in order", () => {
  const repo = initRepo();
  try {
    squashFixture(repo);
    writeCommit(repo, "leaf.txt", "leaf again\n", "later leaf edit");
    let trees;
    const rec = recording((args, cwd, opts) => {
      if (args[0] === "version") return { status: 0, stdout: "git version 2.39.0", stderr: "" };
      if (args[0] === "rev-parse" && args[1]?.endsWith("^{tree}")) {
        const result = git(args, cwd, opts);
        trees = result.stdout.split(/\r?\n/).filter(Boolean);
        return result;
      }
      if (args[0] === "merge-tree" && args.includes("--stdin")) {
        const commits = opts.input.trim().split(/\r?\n/);
        const fields = [];
        for (let i = 0; i < commits.length; i++) {
          if (i === 0) fields.push("0", trees[i], "100644 blob 1\tleaf.txt", "", "1", "leaf.txt", "CONFLICT (content)", "conflict message", "");
          else fields.push("1", i === commits.length - 1 ? trees[i] : "f".repeat(40), "");
        }
        fields.push("");
        const output = fields.join("\0");
        return { status: 0, stdout: output, stderr: "" };
      }
      return git(args, cwd, opts);
    });
    equal(absorbed(must(["rev-parse", "main"], repo), must(["rev-parse", "swarm/leaf"], repo), repo, rec.run), true);
    const batch = rec.calls.filter(({ args }) => args[0] === "merge-tree" && args.includes("--stdin"));
    equal(batch.length, 1);
    equal(batch[0].input.trim().split(/\r?\n/).length, 3);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
