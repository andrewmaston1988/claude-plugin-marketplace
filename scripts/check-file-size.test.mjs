// Tests for the 500-line growth ratchet (`scripts/check-file-size.mjs`).
//
// `violations()` is pure over `[path, oldLines, newLines]`, so the rule is
// testable without git trees. The tests below it run the real CLI against real
// temporary repositories, because the interesting failures live in how those
// triples are DERIVED: a baseline read from a checked-in table of sizes would
// go stale silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BAR,
  RatchetError,
  collectRows,
  inScope,
  lineCount,
  readBlob,
  violations,
} from "./check-file-size.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CHECKER = join(HERE, "check-file-size.mjs");

// --- Fixture plumbing ------------------------------------------------------

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "ratchet@example.com");
  git(dir, "config", "user.name", "ratchet");
  git(dir, "config", "core.autocrlf", "false"); // stable bytes on Windows and Linux
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function writeLines(cwd, rel, n) {
  const p = join(cwd, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "x = 1\n".repeat(n), "utf8");
}

function commitAll(cwd, message) {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", message);
}

function runChecker(cwd, ...args) {
  return spawnSync(process.execPath, [CHECKER, ...args], { cwd, encoding: "utf8" });
}

// --- The core rule: a file over the bar may not grow ------------------------

test("a grandfathered file that grows by one line is blocked", () => {
  const found = violations([["plugins/swarm/src/scheduler.mjs", 1615, 1616]]);
  assert.equal(found.length, 1, found);
  assert.match(found[0], /1615 -> 1616/);
  assert.match(found[0], /plugins\/swarm\/src\/scheduler\.mjs/);
});

test("a grandfathered file that shrinks is allowed", () => {
  assert.deepEqual(violations([["plugins/swarm/src/scheduler.mjs", 1615, 1614]]), []);
});

test("a grandfathered file edited to the same size is allowed", () => {
  assert.deepEqual(violations([["plugins/swarm/src/scheduler.mjs", 1615, 1615]]), []);
});

test("a file under the bar may grow freely", () => {
  assert.deepEqual(violations([["plugins/swarm/src/tiny.mjs", 100, 499]]), []);
});

// --- The boundary: `> bar`, not `>= bar` ------------------------------------

test("exactly at the bar may cross it once", () => {
  assert.deepEqual(
    violations([["plugins/swarm/src/edge.mjs", BAR, BAR + 1]]),
    [],
    "a 500-line file was under the bar when the commit started, so growing it is permitted",
  );
});

test("one line over the bar may not grow", () => {
  const found = violations([["plugins/swarm/src/edge.mjs", BAR + 1, BAR + 2]]);
  assert.equal(found.length, 1, found);
  assert.match(found[0], /501 -> 502/);
});

test("a newly created file at exactly the bar is allowed", () => {
  assert.deepEqual(violations([["plugins/swarm/src/new.mjs", 0, BAR]]), []);
});

test("a newly created file one line over the bar is blocked", () => {
  const found = violations([["plugins/swarm/src/new.mjs", 0, BAR + 1]]);
  assert.equal(found.length, 1, found);
  assert.match(found[0], /new\.mjs/);
  assert.match(found[0], new RegExp(String(BAR + 1)));
});

test("a newly created file well over the bar is blocked", () => {
  assert.equal(violations([["plugins/swarm/src/new.mjs", 0, 900]]).length, 1);
});

test("a deleted file never trips the check", () => {
  assert.deepEqual(violations([["plugins/swarm/src/gone.mjs", 3890, 0]]), []);
});

// --- Reporting -------------------------------------------------------------

test("every offending file is reported in one run", () => {
  const found = violations([
    ["a.mjs", 600, 601],
    ["b.mjs", 100, 200],
    ["c.mjs", 900, 950],
    ["d.mjs", 0, 700],
  ]);
  assert.equal(found.length, 3, found);
  assert.ok(found.some((m) => m.includes("a.mjs")), found);
  assert.ok(found.some((m) => m.includes("c.mjs")), found);
  assert.ok(found.some((m) => m.includes("d.mjs")), found);
});

test("the message names the bar so the fix is obvious", () => {
  assert.match(violations([["a.mjs", 600, 601]])[0], new RegExp(String(BAR)));
});

test("a clean change produces no output at all", () => {
  assert.deepEqual(violations([["a.mjs", 10, 20]]), []);
  assert.deepEqual(violations([]), []);
});

// --- Scope: code plus agent-facing skill Markdown, nothing else -------------

test("code suffixes are in scope", () => {
  for (const p of [
    "plugins/swarm/src/scheduler.mjs",
    "eslint.config.js",
    "plugins/x/tool.cjs",
    "plugins/x/src/a.ts",
    "plugins/x/src/a.tsx",
    "scripts/check_file_size.py",
    "plugins/pipeline/scripts/thing.ps1",
    "plugins/pipeline/scripts/thing.sh",
  ]) {
    assert.ok(inScope(p), `${p} should be in scope`);
  }
});

test("markdown is in scope only below plugins/**/skills/", () => {
  assert.ok(inScope("plugins/swarm/skills/swarm/SKILL.md"));
  assert.ok(inScope("plugins/swarm/skills/swarm/references/topology.md"));
  assert.ok(inScope("plugins/pipeline/skills/merge/SKILL.md"));
});

test("other markdown and non-code files are out of scope", () => {
  for (const p of [
    "README.md",
    "plugins/pipeline/REFERENCE.md",
    "plugins/swarm/README.md",
    "plans/some-plan.md",
    "repos/claude-plugin-marketplace/plans/file-size-ratchet.md",
    "package-lock.json",
    "plugins/x/manifest.json",
    "LICENSE",
  ]) {
    assert.ok(!inScope(p), `${p} should be out of scope`);
  }
});

test("excluded trees are out of scope even for code suffixes", () => {
  for (const p of ["sessions/scratch.mjs", "node_modules/x/index.js", "plugins/x/node_modules/y.js"]) {
    assert.ok(!inScope(p), `${p} should be out of scope`);
  }
});

test("backslash paths normalise before the scope test", () => {
  assert.ok(inScope("plugins\\swarm\\skills\\swarm\\SKILL.md"));
  assert.ok(inScope("plugins\\swarm\\src\\scheduler.mjs"));
});

// --- Line counting ---------------------------------------------------------

test("line counts match trailing-newline and CRLF conventions", () => {
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("a\n"), 1);
  assert.equal(lineCount("a\nb\n"), 2);
  assert.equal(lineCount("a\nb"), 2, "no trailing newline still has two lines");
  assert.equal(lineCount("a\r\nb\r\n"), 2, "CRLF counts as two lines, not four");
  assert.equal(lineCount("\n"), 1);
});

// --- The Git adapter: staged mode ------------------------------------------

test("staged growth of a grandfathered file fails with exit 1", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "big.mjs", BAR + 1);
  commitAll(repo, "seed");
  writeLines(repo, "big.mjs", BAR + 2);
  git(repo, "add", "-A");

  const r = runChecker(repo);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /501 -> 502/);
  assert.match(r.stderr, /big\.mjs/);
});

test("staged shrink of a grandfathered file passes", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "big.mjs", BAR + 1);
  commitAll(repo, "seed");
  writeLines(repo, "big.mjs", BAR);
  git(repo, "add", "-A");

  const r = runChecker(repo);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("staged new file over the bar fails with exit 1", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "seed.mjs", 1);
  commitAll(repo, "seed");
  writeLines(repo, "fresh.mjs", BAR + 1);
  git(repo, "add", "-A");

  const r = runChecker(repo);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /fresh\.mjs/);
});

test("a pure rename preserves the baseline and passes", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "old.mjs", BAR + 100);
  commitAll(repo, "seed");
  git(repo, "mv", "old.mjs", "moved.mjs");
  git(repo, "add", "-A");

  const r = runChecker(repo);
  assert.equal(r.status, 0, `a pure move was read as new debt: ${r.stdout}${r.stderr}`);
});

test("growth across a rename is still caught", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "old.mjs", BAR + 100);
  commitAll(repo, "seed");
  git(repo, "mv", "old.mjs", "moved.mjs");
  writeLines(repo, "moved.mjs", BAR + 101);
  git(repo, "add", "-A");

  const r = runChecker(repo);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`${BAR + 100} -> ${BAR + 101}`));
});

test("a deletion never trips the check", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "big.mjs", BAR + 100);
  commitAll(repo, "seed");
  git(repo, "rm", "-q", "big.mjs");

  const r = runChecker(repo);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("paths with spaces and non-ASCII characters are still checked", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "my file.mjs", BAR + 1);
  writeLines(repo, "café.mjs", BAR + 1);
  commitAll(repo, "seed");
  writeLines(repo, "my file.mjs", BAR + 2);
  writeLines(repo, "café.mjs", BAR + 2);
  git(repo, "add", "-A");

  const r = runChecker(repo);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /my file\.mjs/);
  assert.match(r.stderr, /café\.mjs/);
});

test("several violations are all reported in one run", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "a.mjs", BAR + 1);
  writeLines(repo, "b.mjs", BAR + 2);
  commitAll(repo, "seed");
  writeLines(repo, "a.mjs", BAR + 2);
  writeLines(repo, "b.mjs", BAR + 3);
  writeLines(repo, "brand-new.mjs", BAR + 5);
  git(repo, "add", "-A");

  const r = runChecker(repo);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  for (const name of ["a.mjs", "b.mjs", "brand-new.mjs"]) {
    assert.match(r.stderr, new RegExp(name), `${name} missing from ${r.stderr}`);
  }
});

test("an in-scope skill doc that grows is blocked through the real index", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "plugins/swarm/skills/swarm/SKILL.md", BAR + 10);
  commitAll(repo, "seed");
  writeLines(repo, "plugins/swarm/skills/swarm/SKILL.md", BAR + 20);
  git(repo, "add", "-A");

  const r = runChecker(repo);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /SKILL\.md/);
});

test("out-of-scope files may grow past the bar untouched", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "README.md", 10);
  writeLines(repo, "plugins/pipeline/REFERENCE.md", 10);
  writeLines(repo, "notes.json", 10);
  commitAll(repo, "seed");
  writeLines(repo, "README.md", BAR + 500);
  writeLines(repo, "plugins/pipeline/REFERENCE.md", BAR + 500);
  writeLines(repo, "notes.json", BAR + 500);
  git(repo, "add", "-A");

  const r = runChecker(repo);
  assert.equal(r.status, 0, `out-of-scope files tripped the ratchet: ${r.stdout}${r.stderr}`);
});

test("staged enforcement is repo-wide even when run from a subdirectory", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "plugins/pipeline/src/big.mjs", BAR + 100);
  writeLines(repo, "plugins/swarm/src/small.mjs", 10);
  commitAll(repo, "seed");
  writeLines(repo, "plugins/pipeline/src/big.mjs", BAR + 101);
  git(repo, "add", "-A");

  // `git diff` narrows itself to the launch directory, so a checker run from
  // here would see nothing staged and pass a check it never made.
  const r = runChecker(join(repo, "plugins", "swarm"));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /plugins\/pipeline\/src\/big\.mjs/);
});

// --- The Git adapter: `--against <ref>` (CI's view) ------------------------

test("--against compares the base ref with HEAD, not with the working tree", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "big.mjs", BAR + 100);
  commitAll(repo, "seed");
  const base = git(repo, "rev-parse", "HEAD").trim();

  writeLines(repo, "big.mjs", BAR + 200);
  commitAll(repo, "grow");

  // Deliberately leave a much larger unstaged edit behind: it is not
  // committed, so it must not be the "after" side of the comparison.
  writeLines(repo, "big.mjs", BAR + 400);

  const r = runChecker(repo, "--against", base);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`${BAR + 100} -> ${BAR + 200}`));
  assert.doesNotMatch(r.stderr, new RegExp(String(BAR + 400)));
});

test("--against passes when the committed range is clean", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "small.mjs", 10);
  commitAll(repo, "seed");
  const base = git(repo, "rev-parse", "HEAD").trim();
  writeLines(repo, "small.mjs", 200);
  commitAll(repo, "grow");

  const r = runChecker(repo, "--against", base);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("an all-zero predecessor is reported as no comparable base and passes", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "big.mjs", BAR + 100);
  commitAll(repo, "seed");

  const r = runChecker(repo, "--against", "0".repeat(40));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no comparable base/i, "the skip must be announced, not silent");
});

test("an empty base ref fails closed instead of silently passing", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "big.mjs", BAR + 100);
  commitAll(repo, "seed");

  const r = runChecker(repo, "--against", "");
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /could not read the base ref/);
});

test("a base ref git cannot resolve fails closed", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "seed.mjs", 1);
  commitAll(repo, "seed");

  const r = runChecker(repo, "--against", "1".repeat(40));
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /could not read/);
  assert.match(r.stderr, /failing closed/i);
});

test("a missing after-blob fails closed rather than reading as a deletion", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "seed.mjs", 1);
  commitAll(repo, "seed");
  writeLines(repo, "fresh.mjs", BAR + 1);
  git(repo, "add", "-A");

  assert.throws(
    () =>
      collectRows({
        cwd: repo,
        // Stands in for a listed path whose staged blob cannot be read:
        // `--diff-filter=ACMR` never lists a deletion, so that is an error,
        // never a legitimate 0-line file.
        _readBlob: (ref, path, cwd) =>
          path === "fresh.mjs" && ref === "" ? null : readBlob(ref, path, cwd),
      }),
    (err) => err instanceof RatchetError && /fresh\.mjs/.test(err.message),
  );
});

// --- Inventory -------------------------------------------------------------

test("inventory lists offenders, uses the same scope, and never fails the run", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "big.mjs", BAR + 100);
  writeLines(repo, "small.mjs", 10);
  writeLines(repo, "plugins/swarm/skills/swarm/SKILL.md", BAR + 7);
  writeLines(repo, "README.md", BAR + 300);
  commitAll(repo, "seed");

  const r = runChecker(repo, "--all");
  assert.equal(r.status, 0, `inventory must not block: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /big\.mjs/);
  assert.match(r.stdout, /SKILL\.md/);
  assert.doesNotMatch(r.stdout, /small\.mjs/);
  assert.doesNotMatch(r.stdout, /README\.md/, "inventory must use the enforcement scope");
  assert.match(r.stdout, /2 file\(s\) over the 500-line bar/);
});

test("inventory is root-relative even when run from a subdirectory", (t) => {
  const repo = makeRepo(t);
  writeLines(repo, "plugins/swarm/src/big.mjs", BAR + 100);
  writeLines(repo, "plugins/pipeline/src/other.mjs", BAR + 50);
  commitAll(repo, "seed");

  const r = runChecker(join(repo, "plugins", "swarm"), "--all");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // A report that shrinks with the launch directory is worse than no report:
  // it reads as "clean" while offenders sit in the sibling plugins.
  assert.match(r.stdout, /plugins\/swarm\/src\/big\.mjs/);
  assert.match(r.stdout, /plugins\/pipeline\/src\/other\.mjs/);
  assert.match(r.stdout, /2 file\(s\) over the 500-line bar/);
});

// --- Wiring: one checker, invoked by both the npm script and CI ------------

test("the npm script points at the same checker", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.scripts["check:file-size"], "no check:file-size script in package.json");
  assert.match(pkg.scripts["check:file-size"], /scripts\/check-file-size\.mjs/);
});

test("the CI workflow runs the same checker with full history", () => {
  const yml = readFileSync(join(ROOT, ".github", "workflows", "test.yml"), "utf8");
  assert.match(yml, /scripts\/check-file-size\.mjs/, "the ratchet is not wired into CI");
  assert.match(yml, /fetch-depth:\s*0/, "CI needs complete history or it silently passes");
  assert.match(yml, /--against/, "the CI job must compare against a base ref");
});
