// Selection: what a diff reaches. Failures are in DERIVATION -- the changed
// set, the base it is measured from, the import closure -- so selection runs
// the real graph over fixture repos.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { findSuite } from "./test-suites.mjs";
import { main } from "./test.mjs";
import { changedSet, resolveBase } from "./test-lib/changed.mjs";
import { expandRun, select } from "./test-lib/select.mjs";
import {
  FIX_GLOB,
  HERE,
  commitAll,
  git,
  graphFixture,
  makeRepo,
  suiteOf,
  write,
  capture,
} from "./test-helpers.mjs";

const RUNNER = join(HERE, "test.mjs");

// --- the changed set and its base ------------------------------------------

test("committed, unstaged and untracked changes all enter the changed set", (t) => {
  const repo = makeRepo(t);
  write(repo, "seed.mjs");
  write(repo, ".gitignore", "ignored.txt\n");
  commitAll(repo, "seed");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "committed.mjs");
  commitAll(repo, "committed change");
  write(repo, "unstaged.mjs");
  write(repo, "untracked.mjs");
  write(repo, "ignored.txt");
  const changed = changedSet({ repoRoot: repo, base: resolveBase({ repoRoot: repo }) });
  for (const path of ["committed.mjs", "unstaged.mjs", "untracked.mjs"]) {
    assert.ok(changed.includes(path), `${path} missing from ${changed.join(",")}`);
  }
  assert.ok(!changed.includes("ignored.txt"), "an ignored file is not a change");
});

test("master is the base when there is no origin, and the merge-base is used", (t) => {
  const repo = makeRepo(t);
  write(repo, "seed.mjs");
  commitAll(repo, "seed");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "work.mjs");
  commitAll(repo, "feature work");
  // master moves on: its own commit must not read as this branch's change.
  git(repo, "checkout", "-q", "master");
  write(repo, "elsewhere.mjs");
  commitAll(repo, "master moves");
  git(repo, "checkout", "-q", "feature");
  const changed = changedSet({ repoRoot: repo, base: resolveBase({ repoRoot: repo }) });
  assert.ok(changed.includes("work.mjs"), changed.join(","));
  assert.ok(!changed.includes("elsewhere.mjs"), "master's own commit is not this branch's diff");
});

test("no master and no --against exits 2 naming --against", (t) => {
  const repo = makeRepo(t, "trunk");
  write(repo, "seed.mjs");
  commitAll(repo, "seed");

  const r = spawnSync(process.execPath, [RUNNER, "--list"], { cwd: repo, encoding: "utf8" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--against/);
});

test("--against overrides the branch base and an unknown ref fails closed", (t) => {
  const repo = makeRepo(t);
  write(repo, "seed.mjs");
  commitAll(repo, "seed");
  const base = git(repo, "rev-parse", "HEAD").trim();

  assert.equal(resolveBase({ repoRoot: repo, against: base }), base);
  assert.throws(() => resolveBase({ repoRoot: repo, against: "no-such-ref" }), /not a ref/);
});

// --- the import closure ----------------------------------------------------

const fixEntries = (repo, changed) =>
  select({ suites: [suiteOf("fix", [FIX_GLOB])], changed, repoRoot: repo }).entries;

const selectedFile = (entries, suffix) => entries.filter((entry) => entry.file.endsWith(suffix));

test("a change reaches a test through a transitive import and no further", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/src/a.mjs"]);
  const reached = selectedFile(entries, "transitive.test.mjs");
  assert.equal(reached.length, 1, JSON.stringify(entries));
  assert.equal(reached[0].why, "changed: plugins/fix/src/a.mjs");
  assert.deepEqual(selectedFile(entries, "unrelated.test.mjs"), [], "a test importing neither was selected");
});

test("a string-literal import() enters the closure", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/src/dyn.mjs"]);
  assert.equal(selectedFile(entries, "dynamic.test.mjs").length, 1, JSON.stringify(entries));
});

test("a new URL literal naming a file enters the closure", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/bin/urlonly.mjs"]);
  assert.equal(selectedFile(entries, "url-file.test.mjs").length, 1, JSON.stringify(entries));
});

test("a new URL literal naming a directory adds every file under it", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/templates/a.md"]);
  assert.equal(selectedFile(entries, "url-dir.test.mjs").length, 1, JSON.stringify(entries));
});

test("a URL locator ending in . or .. enumerates no directory contents", (t) => {
  const result = select({ suites: [suiteOf("fix", [FIX_GLOB])], changed: ["plugins/fix/notes.md"], repoRoot: graphFixture(t) });
  assert.deepEqual(result.entries.filter((entry) => entry.why !== "windows"), [], "a plugin-root locator walked the plugin");
  assert.equal(result.docsOnly, true);
});

test("a computed join() path is caught by its basename literal", (t) => {
  const repo = graphFixture(t);
  const cli = fixEntries(repo, ["plugins/fix/bin/joined.mjs"]);
  assert.equal(selectedFile(cli, "join-cli.test.mjs").length, 1, JSON.stringify(cli));
  const skill = fixEntries(repo, ["plugins/fix/skills/x/SKILL.md"]);
  assert.equal(selectedFile(skill, "join-skill.test.mjs").length, 1, JSON.stringify(skill));
});

test("a changed .md in no closure selects nothing and reports docs-only", (t) => {
  const result = select({ suites: [suiteOf("fix", [FIX_GLOB])], changed: ["plugins/fix/notes.md"], repoRoot: graphFixture(t) });
  assert.deepEqual(result.entries.filter((entry) => entry.why !== "windows"), [], "a .md in no closure selected a test");
  assert.equal(result.docsOnly, true);
});

test("a changed non-.md file in no closure runs the whole suite", (t) => {
  const path = "plugins/fix/src/tray/windows.ps1";
  const entries = fixEntries(graphFixture(t), [path]);
  assert.ok(entries.length >= 6, JSON.stringify(entries));
  assert.ok(entries.every((entry) => entry.why === `fallback: ${path}`));
});

test("--list reports the change docs-only through the real CLI", async (t) => {
  const repo = graphFixture(t);
  commitAll(repo, "fixture");
  write(repo, "plugins/fix/extra.md", "more notes\n");
  const out = capture();
  const code = await main(["--list"], {
    cwd: repo,
    _suites: [suiteOf("fix", [FIX_GLOB])],
    _log: out.log,
    _err: out.err,
  });
  assert.equal(code, 0);
  assert.match(out.errors.join("\n"), /docs-only/);
  const rows = out.lines.map((line) => line.split(" ").slice(0, 2).join(" "));
  assert.deepEqual(rows, ["fix plugins/fix/tests/thing.win.test.mjs"], ".md selects nothing");
});

test("lockfiles and plugin manifests run the whole suite", (t) => {
  const repo = graphFixture(t);
  const suite = [suiteOf("fix", [FIX_GLOB])];
  const all = expandRun(suite[0].runs[0], { repoRoot: repo }).length;
  const fallbacks = ["plugins/fix/package.json", "plugins/fix/package-lock.json",
    "plugins/fix/.claude-plugin/plugin.json", "plugins/fix/.codex-plugin/plugin.json",
    "plugins/fix/hooks/hooks.json", "plugins/fix/.env.test"];
  for (const path of fallbacks) {
    const { entries } = select({ suites: suite, changed: [path], repoRoot: repo });
    assert.equal(entries.length, all, `${path} should run the whole suite`);
    assert.ok(entries.every((entry) => entry.why === `fallback: ${path}`), path);
  }
});

test("a change under a suite's own home, outside plugins/, selects that suite whole", (t) => {
  const repo = makeRepo(t);
  write(repo, "bakeoff/ui-probe/protocols/protocol.mjs");
  write(repo, "bakeoff/ui-probe/protocols/tests/smoke.test.mjs");
  write(repo, FIX_GLOB.replace("*.test.mjs", "transitive.test.mjs"));
  const suites = [findSuite("ui-probe"), suiteOf("fix", [FIX_GLOB])];
  const path = "bakeoff/ui-probe/protocols/x.mjs";

  const { entries, docsOnly } = select({ suites, changed: [path], repoRoot: repo });
  const chosen = entries.filter((entry) => entry.suite === "ui-probe");
  assert.ok(
    chosen.some((entry) => entry.file === "bakeoff/ui-probe/protocols/tests/smoke.test.mjs"),
    JSON.stringify(entries),
  );
  assert.ok(chosen.every((entry) => entry.why === `fallback: ${path}`), JSON.stringify(entries));
  assert.deepEqual(entries.filter((entry) => entry.suite === "fix"), [], "a bakeoff change selected a plugin");
  assert.equal(docsOnly, false);
});

test("a change under scripts/ runs the repo suite, not a plugin's", (t) => {
  const repo = graphFixture(t);
  const suites = [suiteOf("fix", [FIX_GLOB]), suiteOf("repo", ["scripts/*.test.mjs"])];
  const path = "scripts/x.mjs";
  const { entries } = select({ suites, changed: [path], repoRoot: repo });
  const repoEntries = entries.filter((entry) => entry.suite === "repo");
  assert.equal(repoEntries.length, 1, path);
  assert.equal(repoEntries[0].why, `fallback: ${path}`);
  const attributed = entries.filter((entry) => entry.suite === "fix" && entry.why !== "windows");
  assert.deepEqual(attributed, [], "a repo-level change must not select a plugin test");
});

test("a workflow change selects every suite, because it decides what CI runs", (t) => {
  const repo = graphFixture(t);
  const suites = [suiteOf("fix", [FIX_GLOB]), suiteOf("repo", ["scripts/*.test.mjs"])];
  const path = ".github/workflows/test.yml";
  const { entries } = select({ suites, changed: [path], repoRoot: repo });
  for (const name of ["fix", "repo"]) {
    const chosenSuite = entries.filter((entry) => entry.suite === name);
    assert.ok(chosenSuite.length > 0, `${name} was not selected by ${path}`);
    assert.ok(chosenSuite.every((entry) => entry.why === `fallback: ${path}`), name);
  }
});

test("a .win.test.mjs is selected by a diff that touches none of it", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/notes.md"]);
  const win = selectedFile(entries, ".win.test.mjs");
  assert.equal(win.length, 1, JSON.stringify(entries));
  assert.equal(win[0].why, "windows");
});

test("** matches zero or more directories, * matches one level", (t) => {
  const repo = makeRepo(t);
  write(repo, "tests/a.test.mjs");
  write(repo, "tests/deep/b.test.mjs");
  write(repo, "tests/deep/deeper/c.test.mjs");

  const deep = expandRun({ cwd: ".", globs: ["tests/**/*.test.mjs"] }, { repoRoot: repo });
  assert.deepEqual(deep, ["tests/a.test.mjs", "tests/deep/b.test.mjs", "tests/deep/deeper/c.test.mjs"]);
  const flat = expandRun({ cwd: ".", globs: ["tests/*.test.mjs"] }, { repoRoot: repo });
  assert.deepEqual(flat, ["tests/a.test.mjs"]);
});
