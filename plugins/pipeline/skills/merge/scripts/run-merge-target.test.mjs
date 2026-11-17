// run-merge-target.test.mjs — target-branch resolution and the dry-run main()
// paths, driven over throwaway git repos. Split from run-merge.test.mjs to stay
// under the file-size bar.
import "../../../tests/helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok, match } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { main, banner, collectSignals, resolveTargetBranch } from "./run-merge.mjs";

// ── Scenario 2 — plansDir resolution and the unresolvable-template PAUSE ──────
// Drives main() over a throwaway git repo. The production failure this reproduces: a
// {codeRoot} template resolved to a path with the token intact and the driver printed the
// spawn command with that path attached to --plans-dir.
//
// Fixture precondition, load-bearing: the repo must NOT contain a plans/ directory. The
// existence fallback substitutes <projectDir>/plans whenever the configured dir is missing,
// which would swallow the RED and make these pass against unfixed code.

function tmpRepo(branch = "autonomous/feat-x") {
  const dir = mkdtempSync(join(tmpdir(), "run-merge-")).replace(/\\/g, "/");
  // -c core.hooksPath= : a global hooksPath would run the operator's real hooks in this
  // throwaway repo and fail the seed commit, leaving no HEAD for `git branch` to point at.
  const g = (...a) => {
    const r = spawnSync("git", ["-c", "core.hooksPath=", ...a], { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`fixture git ${a.join(" ")} failed: ${r.stderr || r.stdout}`);
    return r;
  };
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  // resolveTargetBranch falls back to `git config init.defaultBranch`, which reads system
  // config — "master" on this machine. Pin it so the target branch is one the fixture has.
  g("config", "init.defaultBranch", "main");
  // A global core.hooksPath would run the operator's real hooks in this throwaway repo and
  // fail the seed commit — leaving no HEAD, so `git branch` silently makes no branch.
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  g("add", "-A");
  g("commit", "-qm", "seed");
  g("branch", branch);
  ok(!existsSync(join(dir, "plans")), "fixture must have no plans/ — it would mask the RED");
  return dir;
}

test("resolveTargetBranch: explicit target beats origin/HEAD", () => {
  const dir = tmpRepo();
  try {
    const g = (...a) => spawnSync("git", ["-c", "core.hooksPath=", ...a], { cwd: dir, encoding: "utf8" });
    g("update-ref", "refs/remotes/origin/main", "HEAD");
    g("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    equal(resolveTargetBranch("noproj", "feat-x", dir, "release"), "release");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveTargetBranch: explicit target beats the pipeline row override", () => {
  const dir = tmpRepo();
  const oldPath = process.env.PATH;
  try {
    stubRow(dir, '[{"target_branch":"develop"}]');
    process.env.PATH = `${dir}${delimiter}${oldPath}`;
    equal(resolveTargetBranch("noproj", "feat-x", dir, "release"), "release");
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveTargetBranch: absent or empty explicit target preserves origin/HEAD", () => {
  const dir = tmpRepo();
  try {
    const g = (...a) => spawnSync("git", ["-c", "core.hooksPath=", ...a], { cwd: dir, encoding: "utf8" });
    g("update-ref", "refs/remotes/origin/main", "HEAD");
    g("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    equal(resolveTargetBranch("noproj", "feat-x", dir, undefined), "main");
    equal(resolveTargetBranch("noproj", "feat-x", dir, ""), "main");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function runMain(dir, config, { branch = "autonomous/feat-x", projectRow = null, extraArgs = [] } = {}) {
  let buf = "";
  const write = process.stdout.write;
  const ewrite = process.stderr.write;
  process.stdout.write = (s) => { buf += s; return true; };
  process.stderr.write = (s) => { buf += s; return true; };
  try {
    await main({
      _argv:       ["--branches", branch, "--project-dir", dir, "--dry-run", ...extraArgs],
      _config:     config,
      _projectRow: projectRow,
    });
  } finally {
    process.stdout.write = write;
    process.stderr.write = ewrite;
  }
  return buf;
}

test("main: explicit target is reported and carried into the merge command", async () => {
  const dir = tmpRepo();
  try {
    const g = (...a) => spawnSync("git", ["-c", "core.hooksPath=", ...a], { cwd: dir, encoding: "utf8" });
    g("update-ref", "refs/remotes/origin/main", "HEAD");
    g("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    g("branch", "release");
    const outText = await runMain(dir, { plansDir: "{root}/plans" }, { extraArgs: ["--target-branch", "release"] });
    match(outText, /targetBranch:\s+release/);
    match(outText, /--target-branch "release"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PAUSE: an unresolvable template stops the merge instead of reaching --plans-dir", async () => {
  const dir = tmpRepo();
  try {
    const outText = await runMain(dir, { plansDir: "{codeRoot}/x/{project}" });
    match(outText, /PAUSE: Plans directory template cannot resolve/);
    match(outText, /\{codeRoot\}/);
    match(outText, /RE-RUN EXACTLY/);
    // The assertion that matters. Asserting only on the word PAUSE would still pass if the
    // driver printed the banner AND the command — which is the bug.
    ok(!outText.includes("Spawn a background agent"), "must not reach the spawn");
    ok(!outText.includes("--plans-dir"), "must not emit a broken --plans-dir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PAUSE: fires on {branch} too — known globally, unresolvable for a plans dir", async () => {
  const dir = tmpRepo();
  try {
    const outText = await runMain(dir, { plansDir: "{root_parent}/{branch}/plans" });
    match(outText, /PAUSE: Plans directory template cannot resolve/);
    match(outText, /\{branch\}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PAUSE: a repo plans/ does not stand in for an unresolvable template", async () => {
  const dir = tmpRepo();
  try {
    mkdirSync(join(dir, "plans"));
    const outText = await runMain(dir, { plansDir: "{codeRoot}/x/{project}" });
    match(outText, /PAUSE: Plans directory template cannot resolve/);
    ok(!outText.includes("--plans-dir"), "must not emit the fallback --plans-dir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The false-positive guard: without it the pause could fire on everything and the suite
// would report green.
test("PAUSE: a valid template still reaches the spawn", async () => {
  const dir = tmpRepo();
  try {
    const outText = await runMain(dir, { plansDir: "{root}/plans" });
    ok(!outText.includes("PAUSE: Plans directory template"), "valid template must not pause");
    match(outText, /would spawn a background agent|Spawn a background agent/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Ordering: a typo'd branch and a stale template can both be true. The branch name is the
// more actionable failure, so it must win.
test("a missing branch is reported before the plansDir pause", async () => {
  const dir = tmpRepo();
  try {
    const outText = await runMain(dir, { plansDir: "{codeRoot}/x" }, { branch: "autonomous/typo-brnach" });
    match(outText, /branch not found/);
    ok(!outText.includes("PAUSE: Plans directory template"), "branch check must come first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Target-branch tiers — /merge's own order ─────────────────────────────────
// A branch with no row must still merge to its plan's *Target-Branch:*, not origin/HEAD.

// The fixture creates only `autonomous/feat-x`; a target has to exist as a ref or the
// resolution is refused, so each test names the refs its scenario needs.
function addBranch(dir, name) {
  spawnSync("git", ["-c", "core.hooksPath=", "branch", name], { cwd: dir, encoding: "utf8" });
}

function originHead(dir, name) {
  const g = (...a) => spawnSync("git", ["-c", "core.hooksPath=", ...a], { cwd: dir, encoding: "utf8" });
  g("update-ref", `refs/remotes/origin/${name}`, "HEAD");
  g("symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${name}`);
}

function writePlan(dir, body, { complete = false } = {}) {
  const plansDir = join(dir, "plans");
  mkdirSync(complete ? join(plansDir, "complete") : plansDir, { recursive: true });
  writeFileSync(join(plansDir, complete ? "complete/feat-x.md" : "feat-x.md"), body);
}

// pipeline-query shells out to the CLI; a shim on PATH answers for it — .cmd on Windows, a
// shell script elsewhere (CI). The payload must be an ARRAY: rowField reads a row list, so a
// bare object parses to "no value" and the stub silently answers nothing.
function stubRow(dir, json) {
  writeFileSync(join(dir, "pipeline.cmd"), `@echo ${json}\r\n`);
  writeFileSync(join(dir, "pipeline"), `#!/bin/sh\necho '${json}'\n`, { mode: 0o755 });
}

test("main: the plan's *Target-Branch:* beats origin/HEAD", async () => {
  const dir = tmpRepo();
  try {
    originHead(dir, "main");
    addBranch(dir, "staging");
    writePlan(dir, "*Target-Branch:* staging\n");
    const outText = await runMain(dir, { plansDir: "{root}/plans" });
    match(outText, /targetBranch:\s+staging \(tier: plan\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main: the row's target_branch beats the plan annotation", async () => {
  const dir = tmpRepo();
  const oldPath = process.env.PATH;
  try {
    stubRow(dir, '[{"target_branch":"develop"}]');
    process.env.PATH = `${dir}${delimiter}${oldPath}`;
    addBranch(dir, "develop");
    writePlan(dir, "*Target-Branch:* staging\n");
    const outText = await runMain(dir, { plansDir: "{root}/plans" });
    match(outText, /targetBranch:\s+develop \(tier: row\)/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main: the flag beats the row and the plan", async () => {
  const dir = tmpRepo();
  const oldPath = process.env.PATH;
  try {
    stubRow(dir, '[{"target_branch":"develop"}]');
    process.env.PATH = `${dir}${delimiter}${oldPath}`;
    addBranch(dir, "release");
    writePlan(dir, "*Target-Branch:* staging\n");
    const outText = await runMain(
      dir,
      { plansDir: "{root}/plans" },
      { extraArgs: ["--target-branch", "release"] },
    );
    match(outText, /targetBranch:\s+release \(tier: flag\)/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

// A plan that declares the branch it works ON must not become the branch it merges
// INTO — the same guard a row value gets, and the same trap *Branch:* exists for.
test("main: an annotation naming the source branch is ignored, not merged onto itself", async () => {
  const dir = tmpRepo();
  try {
    originHead(dir, "main");
    writePlan(dir, "*Target-Branch:* autonomous/feat-x\n");
    const outText = await runMain(dir, { plansDir: "{root}/plans" });
    match(outText, /targetBranch:\s+main \(tier: default\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A resumed merge runs after step 6 moved the plan, so complete/ has to be searched. The
// world probe reads complete/ too, so this run is complete and stops before the resolved
// block — the target it names there is still the evidence that the plan supplied it.
test("main: a plan already moved to complete/ still supplies the target", async () => {
  const dir = tmpRepo();
  try {
    originHead(dir, "main");
    addBranch(dir, "staging");
    writePlan(dir, "*Target-Branch:* staging\n", { complete: true });
    const outText = await runMain(dir, { plansDir: "{root}/plans" });
    match(outText, /already applied to staging/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Reported as a missing SOURCE branch today, because collectSignals probes
// `merge-base --is-ancestor <target> <branch>` and an unknown revision just exits 128.
// The operator never typed the branch that is wrong.
test("main: an unknown target is refused naming the target and the tier it came from", async () => {
  const dir = tmpRepo();
  try {
    originHead(dir, "main");
    writePlan(dir, "*Target-Branch:* staging\n");
    const outText = await runMain(dir, { plansDir: "{root}/plans" });
    match(outText, /REFUSED/);
    match(outText, /'staging'/);
    match(outText, /tier: plan/);
    ok(!/would spawn a background agent/i.test(outText), "must not reach the spawn");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Precedence the hand-rolled resolver never saw: the project row's plans_dir column.
test("the project row's plans_dir column wins over cfg.plansDir", async () => {
  const dir = tmpRepo();
  mkdirSync(join(dir, "row-plans"));
  try {
    const outText = await runMain(
      dir,
      { plansDir: "{root}/plans" },
      { projectRow: { plans_dir: `${dir}/row-plans` } },
    );
    match(outText, new RegExp(`plansDir:\\s+${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/row-plans`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
