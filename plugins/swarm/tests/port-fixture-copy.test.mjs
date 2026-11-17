// Row P1: a fixture call hands back a copy of a per-process template, so the copy must be
// a working repo of its own — same records modulo the home path, worktrees rebound under
// its own dir, its own runs key — and nothing it does may reach the template.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { git, portFixture, portFixtureTemplate, takenFixture, takenFixtureTemplate, writeCommit } from "./helpers/port-fixture.mjs";
import { runLiveness } from "../src/runlog.mjs";
import { projectRunsHoldingWorktrees } from "../src/prune-nudge.mjs";

const SESSION = "sess-copy";
const slash = (p) => p.replaceAll("\\", "/");

// Every form the home path takes in the fixture: raw, git's forward-slash rendering, and
// the JSON-escaped one. The runs key then collapses to a placeholder of its own.
function strip(text, f) {
  const forms = [f.home, slash(f.home), JSON.stringify(f.home).slice(1, -1)];
  for (const form of forms) text = text.split(form).join("<HOME>");
  return text.split(basename(f.runsRoot)).join("<KEY>");
}

const record = (f, name) => JSON.parse(strip(readFileSync(join(f.runDir, name), "utf8"), f));

const worktreePaths = (repo) => git(["worktree", "list", "--porcelain"], repo).stdout
  .split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));

const refs = (repo) => git(["for-each-ref", "--format=%(refname) %(objectname)"], repo).stdout;

test("row P1: a copied taken fixture equals its template", () => {
  const tmpl = takenFixtureTemplate({ launcher: SESSION });
  const f = takenFixture({ launcher: SESSION });
  try {
    ok(f.home !== tmpl.home, "a call returned the template itself");
    for (const name of ["manifest.json", "summary.json", `trees/${f.lane.id}.json`]) {
      deepEqual(record(f, name), record(tmpl, name), name);
    }
    const summary = JSON.parse(readFileSync(join(f.runDir, "summary.json"), "utf8"));
    ok(slash(summary.worktreesKept[0].path).startsWith(slash(f.home)), summary.worktreesKept[0].path);
    ok(slash(summary.worktreesKept[0].repo).startsWith(slash(f.home)), summary.worktreesKept[0].repo);

    const paths = worktreePaths(f.repo);
    ok(paths.length >= 1);
    for (const p of paths) ok(slash(p).startsWith(slash(f.home)), `worktree outside the copy: ${p}`);
    equal(git(["rev-parse", "HEAD"], f.lane.path).stdout, f.lane.tip);
    equal(git(["status", "--porcelain"], f.lane.path).stdout, "");

    const live = runLiveness(f.runDir);
    ok(live.finishedMs, "copied run is not read as finished");
    equal(live.finishedMs, runLiveness(tmpl.runDir).finishedMs);

    deepEqual(projectRunsHoldingWorktrees({ home: f.home, toplevel: f.toplevel, sessionId: SESSION }).mine.map((r) => r.kept), [1]);
    equal(projectRunsHoldingWorktrees({ home: f.home, toplevel: tmpl.toplevel, sessionId: SESSION }).mine.length, 0);
  } finally { f.cleanup(); }
});

test("row P1: a commit in the taken copy leaves the template unchanged", () => {
  const tmpl = takenFixtureTemplate({ launcher: SESSION });
  const before = refs(tmpl.repo);
  const f = takenFixture({ launcher: SESSION });
  try {
    writeCommit(f.lane.path, "copy-only.txt", "copy\n", "copy-only");
    ok(refs(f.repo) !== before, "the copy's commit did not move the copy");
    equal(refs(tmpl.repo), before);
    equal(git(["status", "--porcelain"], f.lane.path).stdout, "");
  } finally { f.cleanup(); }
});

test("row P1: a copied port fixture is rebound to its own paths", () => {
  const tmpl = portFixtureTemplate();
  const f = portFixture();
  try {
    ok(f.home !== tmpl.home);
    const leaf = f.leaf("run-9", "leaf");
    equal(git(["rev-parse", "HEAD"], leaf.path).stdout, leaf.sha);
    const paths = worktreePaths(f.repo);
    ok(paths.some((p) => slash(p) === slash(leaf.path)), "the copy's new worktree is not listed");
    for (const p of paths) ok(!slash(p).startsWith(slash(tmpl.home)), `worktree names the template: ${p}`);

    const before = refs(tmpl.repo);
    writeCommit(leaf.path, "copy-only.txt", "copy\n", "copy-only");
    ok(refs(f.repo) !== before, "the copy's commit did not move the copy");
    equal(refs(tmpl.repo), before);
  } finally { f.cleanup(); }
});
