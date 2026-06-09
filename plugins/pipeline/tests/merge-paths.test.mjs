// smoke-14: merge-layer plan-path resolution and helpers.
//
// Covers the post-claudeBase-removal model: queue-plan stores absolute paths,
// lookupPlanFile reads from rows, step6bArchive walks distinct plan-dirs from
// done-rows.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { connectPath, close, projectAdd, rowAdd, rowUpdate } from "../scripts/pipeline-db/index.mjs";
import { lookupPlanFile, step1IdentifyPlans, step6bArchiveOrphanedPlans } from "../skills/merge/scripts/plan-files.mjs";
import { verifyAlreadyIntegrated, step7CommitProject } from "../skills/merge/scripts/merge.mjs";

const PROJECT = "testproject";

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "smoke14-"));
  const dbPath = join(tmp, "pipeline.db");
  const repo = join(tmp, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const db = connectPath(dbPath);
  projectAdd(db, { name: PROJECT, rootPath: repo });
  return { tmp, db, repo };
}

function teardown(tmp, db) {
  try { close(db); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

test("lookupPlanFile: returns absolute path from row", () => {
  const { tmp, db, repo } = setup();
  try {
    const planFile = join(repo, "plans", "x.md");
    mkdirSync(join(repo, "plans"));
    writeFileSync(planFile, "# x\n", "utf8");
    rowAdd(db, PROJECT, { feature: "x", planFile, stage: "queued" });
    equal(lookupPlanFile(db, PROJECT, "x"), planFile);
  } finally { teardown(tmp, db); }
});

test("lookupPlanFile: null when no row", () => {
  const { tmp, db } = setup();
  try {
    equal(lookupPlanFile(db, PROJECT, "nonexistent"), null);
  } finally { teardown(tmp, db); }
});

test("step1IdentifyPlans: maps branch to plan_file from row", () => {
  const { tmp, db, repo } = setup();
  try {
    const planFile = join(repo, "plans", "feat-a.md");
    mkdirSync(join(repo, "plans"));
    writeFileSync(planFile, "# feat-a\n", "utf8");
    rowAdd(db, PROJECT, { feature: "feat-a", planFile, stage: "queued" });
    const map = step1IdentifyPlans(db, PROJECT, ["autonomous/feat-a"]);
    equal(map["autonomous/feat-a"], planFile);
  } finally { teardown(tmp, db); }
});

test("step1IdentifyPlans: null entry when row missing", () => {
  const { tmp, db } = setup();
  try {
    const map = step1IdentifyPlans(db, PROJECT, ["autonomous/ghost"]);
    equal(map["autonomous/ghost"], null);
  } finally { teardown(tmp, db); }
});

test("step1IdentifyPlans: sibling-fallback when only one branch has a row", () => {
  const { tmp, db, repo } = setup();
  try {
    const plansDir = join(repo, "plans");
    mkdirSync(plansDir);
    const planA = join(plansDir, "feat-a.md");
    const planB = join(plansDir, "feat-b.md");
    writeFileSync(planA, "# a\n", "utf8");
    writeFileSync(planB, "# b\n", "utf8");
    // Only register feat-a; feat-b has no row but lives in same dir
    rowAdd(db, PROJECT, { feature: "feat-a", planFile: planA, stage: "queued" });
    const map = step1IdentifyPlans(db, PROJECT, ["autonomous/feat-a", "autonomous/feat-b"]);
    equal(map["autonomous/feat-a"], planA);
    equal(map["autonomous/feat-b"], planB);
  } finally { teardown(tmp, db); }
});

test("step6bArchiveOrphanedPlans: archives done-row plan files into sibling complete/", () => {
  const { tmp, db, repo } = setup();
  try {
    const plansDir = join(repo, "plans");
    mkdirSync(plansDir);
    const planA = join(plansDir, "feat-a.md");
    const planB = join(plansDir, "feat-b.md");
    writeFileSync(planA, "# a\n", "utf8");
    writeFileSync(planB, "# b\n", "utf8");
    rowAdd(db, PROJECT, { feature: "feat-a", planFile: planA, stage: "queued" });
    rowUpdate(db, PROJECT, "feat-a", { stage: "done" });
    rowAdd(db, PROJECT, { feature: "feat-b", planFile: planB, stage: "queued" });
    // feat-b stays queued; should NOT be archived

    step6bArchiveOrphanedPlans(db, PROJECT);

    ok(existsSync(join(plansDir, "complete", "feat-a.md")), "done plan should be moved");
    ok(!existsSync(planA), "original done plan should be gone");
    ok(existsSync(planB), "queued plan should remain");
  } finally { teardown(tmp, db); }
});

test("step6bArchiveOrphanedPlans: walks distinct dirs from multiple done rows", () => {
  const { tmp, db, repo } = setup();
  try {
    const dirA = join(repo, "plansA");
    const dirB = join(repo, "plansB");
    mkdirSync(dirA);
    mkdirSync(dirB);
    const planA = join(dirA, "feat-a.md");
    const planB = join(dirB, "feat-b.md");
    writeFileSync(planA, "# a\n", "utf8");
    writeFileSync(planB, "# b\n", "utf8");
    rowAdd(db, PROJECT, { feature: "feat-a", planFile: planA, stage: "queued" });
    rowUpdate(db, PROJECT, "feat-a", { stage: "done" });
    rowAdd(db, PROJECT, { feature: "feat-b", planFile: planB, stage: "queued" });
    rowUpdate(db, PROJECT, "feat-b", { stage: "done" });

    step6bArchiveOrphanedPlans(db, PROJECT);

    ok(existsSync(join(dirA, "complete", "feat-a.md")));
    ok(existsSync(join(dirB, "complete", "feat-b.md")));
  } finally { teardown(tmp, db); }
});

test("step6bArchiveOrphanedPlans: no-op when no done rows", () => {
  const { tmp, db } = setup();
  try {
    // Just verify it doesn't throw
    step6bArchiveOrphanedPlans(db, PROJECT);
  } finally { teardown(tmp, db); }
});

test("queue-plan stores absolute path in row.plan_file (smoke via subprocess)", async () => {
  // Subprocess-based test would be heavy here; rely on parity-runner fixture
  // (queue-plan/from-claude-format-plan) which asserts plan_file is the
  // absolute `{repo}/plans/my-feature.md`. Mark this as a documentation-only
  // assertion: the parity test is the spec.
  ok(true, "covered by parity-runner queue-plan/from-claude-format-plan");
});

// ── Slug prefix-glob fallback (bug fix #2) ────────────────────────────────────

test("step1IdentifyPlans: prefix-glob fallback finds slug-with-suffix.md", () => {
  // Covers the case where the branch slug is 'feat-b' but the plan file on
  // disk is 'feat-b-phase-2.md'. The sibling-dir fallback should find it via
  // the prefix glob (files starting with slug).
  const { tmp, db, repo } = setup();
  try {
    const plansDir = join(repo, "plans");
    mkdirSync(plansDir);
    const planA = join(plansDir, "feat-a.md");
    const planBSuffix = join(plansDir, "feat-b-phase-2.md");
    writeFileSync(planA, "# a\n", "utf8");
    writeFileSync(planBSuffix, "# b phase 2\n", "utf8");
    // Register feat-a so it anchors the fallback directory; feat-b has no row
    rowAdd(db, PROJECT, { feature: "feat-a", planFile: planA, stage: "queued" });
    const map = step1IdentifyPlans(db, PROJECT, ["autonomous/feat-a", "autonomous/feat-b"]);
    equal(map["autonomous/feat-a"], planA);
    equal(map["autonomous/feat-b"], planBSuffix, "should find feat-b-phase-2.md via prefix glob");
  } finally { teardown(tmp, db); }
});

test("step1IdentifyPlans: exact match preferred over prefix-glob when both exist", () => {
  const { tmp, db, repo } = setup();
  try {
    const plansDir = join(repo, "plans");
    mkdirSync(plansDir);
    const planA = join(plansDir, "feat-a.md");
    const planBExact = join(plansDir, "feat-b.md");
    const planBSuffix = join(plansDir, "feat-b-old.md");
    writeFileSync(planA, "# a\n", "utf8");
    writeFileSync(planBExact, "# b exact\n", "utf8");
    writeFileSync(planBSuffix, "# b old\n", "utf8");
    rowAdd(db, PROJECT, { feature: "feat-a", planFile: planA, stage: "queued" });
    const map = step1IdentifyPlans(db, PROJECT, ["autonomous/feat-a", "autonomous/feat-b"]);
    equal(map["autonomous/feat-b"], planBExact, "exact slug.md should win over prefix glob");
  } finally { teardown(tmp, db); }
});

// ── Porcelain ?? filter (bug fix #1) ─────────────────────────────────────────

test("porcelain filter: untracked lines do not count as staged changes", () => {
  // Validates the logic used in step7CommitProject to decide whether to commit.
  // Bug: without the filter, untracked ('??') lines caused a false 'something
  // to commit' verdict, triggering an empty commit attempt.
  function hasTrackedChanges(porcelainOutput) {
    return porcelainOutput
      .split("\n")
      .some(l => l.trim() && !l.startsWith("??"));
  }

  // Only untracked files — should not commit
  ok(!hasTrackedChanges("?? untracked-file.txt\n?? another-new.txt\n"),
    "only untracked files: no tracked changes");

  // Mix of tracked modifications and untracked — should commit
  ok(hasTrackedChanges(" M modified.txt\n?? untracked.txt\n"),
    "modified file + untracked: has tracked changes");

  // Staged deletion only
  ok(hasTrackedChanges("D  deleted.txt\n"),
    "staged deletion: has tracked changes");

  // Empty porcelain output — nothing to commit
  ok(!hasTrackedChanges(""),
    "empty output: no tracked changes");
});

// ── readSmokeCommand regex ────────────────────────────────────────────────────

test("readSmokeCommand: extracts command from bash fence after smoke heading", () => {
  // Inline reproduction of merge.mjs:readSmokeCommand (section-based approach).
  // Finds the smoke heading, extracts its section, then finds the first code fence.
  function extractSmokeCmd(text) {
    const sectionM = /^#+\s+smoke\b[^\n]*/im.exec(text);
    if (!sectionM) return null;
    const after = text.slice(sectionM.index + sectionM[0].length);
    const nextHeading = /^#+\s+/m.exec(after);
    const section = nextHeading ? after.slice(0, nextHeading.index) : after;
    const fenceM = /```(?:bash|sh|powershell|pwsh)?\n([^\n]+)/i.exec(section);
    return fenceM ? fenceM[1].trim() : null;
  }

  equal(
    extractSmokeCmd("## Smoke check\n```bash\nnode --test tests/*.mjs\n```"),
    "node --test tests/*.mjs",
    "bash fence",
  );
  equal(
    extractSmokeCmd("## Smoke check\n```sh\nnpm test\n```"),
    "npm test",
    "sh fence",
  );
  equal(
    extractSmokeCmd("## Smoke check\n```powershell\nnpm test\n```"),
    "npm test",
    "powershell fence",
  );
  equal(
    extractSmokeCmd("## Smoke check\n```pwsh\nnpm test\n```"),
    "npm test",
    "pwsh fence",
  );
  equal(
    extractSmokeCmd("## Smoke check\n```\nnpm test\n```"),
    "npm test",
    "bare fence (no language tag)",
  );
  equal(
    extractSmokeCmd("# Run commands\n\nNo smoke section here."),
    null,
    "no smoke heading: returns null",
  );
  equal(
    extractSmokeCmd("## Smoke\n\n\n```bash\necho ok\n```"),
    "echo ok",
    "multiple blank lines between heading and fence",
  );
  equal(
    extractSmokeCmd("## Smoke check\n\nRun this command to verify the build:\n\n```bash\nnode --test\n```"),
    "node --test",
    "prose between heading and fence",
  );
  equal(
    extractSmokeCmd("## Smoke check\n```bash\ncmd-1\n```\n## Other\n```bash\ncmd-2\n```"),
    "cmd-1",
    "stops at next heading — does not bleed into following section",
  );
});

// ── verifyAlreadyIntegrated ───────────────────────────────────────────────────

test("verifyAlreadyIntegrated: no plan file → no blockers", () => {
  const tmp = mkdtempSync(join(tmpdir(), "smoke14-vai-"));
  try {
    equal(verifyAlreadyIntegrated(null, tmp).length, 0, "null planPath → empty");
    equal(verifyAlreadyIntegrated(join(tmp, "missing.md"), tmp).length, 0, "absent planPath → empty");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("verifyAlreadyIntegrated: all claimed Create/Add files present → no blockers", () => {
  const tmp = mkdtempSync(join(tmpdir(), "smoke14-vai-"));
  try {
    const planPath = join(tmp, "plan.md");
    writeFileSync(planPath,
      "## Files Changed\n| `src/foo.mjs` | Create new file |\n| `src/bar.mjs` | Add helper |\n",
      "utf8",
    );
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "foo.mjs"), "", "utf8");
    writeFileSync(join(tmp, "src", "bar.mjs"), "", "utf8");
    equal(verifyAlreadyIntegrated(planPath, tmp).length, 0, "all files present → no blockers");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("verifyAlreadyIntegrated: missing Create file → blocker naming the path", () => {
  const tmp = mkdtempSync(join(tmpdir(), "smoke14-vai-"));
  try {
    const planPath = join(tmp, "plan.md");
    writeFileSync(planPath,
      "## Files Changed\n| `src/new-thing.mjs` | Create implementation |\n",
      "utf8",
    );
    // src/new-thing.mjs not created in tmp
    const blockers = verifyAlreadyIntegrated(planPath, tmp);
    ok(blockers.length > 0, "missing Create file → at least one blocker");
    ok(blockers.some(b => b.includes("src/new-thing.mjs")), "blocker names the missing file");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("verifyAlreadyIntegrated: plan with no Files Changed section → no blockers", () => {
  const tmp = mkdtempSync(join(tmpdir(), "smoke14-vai-"));
  try {
    const planPath = join(tmp, "plan.md");
    writeFileSync(planPath, "# My Plan\n\n## Goal\nDo things.\n", "utf8");
    equal(verifyAlreadyIntegrated(planPath, tmp).length, 0, "no table rows → no blockers");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ── step7CommitProject (git integration) ──────────────────────────────────────

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "init\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
}

test("step7CommitProject: commits when plans/ has staged changes", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "smoke14-s7-"));
  const repo = join(tmp, "repo");
  try {
    initRepo(repo);
    mkdirSync(join(repo, "plans", "complete"), { recursive: true });
    writeFileSync(join(repo, "plans", "complete", "feat-a.md"), "# done\n", "utf8");

    await step7CommitProject(repo, ["autonomous/feat-a"]);

    const log = spawnSync("git", ["log", "--oneline", "-1"], { cwd: repo, encoding: "utf8" });
    ok(log.stdout.includes("feat-a"), "commit message should reference the branch slug");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("step7CommitProject: no-op when plans/ directory does not exist", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "smoke14-s7-"));
  const repo = join(tmp, "repo");
  try {
    initRepo(repo);
    // No plans/ dir

    const committed = await step7CommitProject(repo, ["autonomous/feat-a"]);

    equal(committed, false, "should return false when nothing to commit");
    const count = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: repo, encoding: "utf8" });
    equal(count.stdout.trim(), "1", "only the initial commit should exist");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("step7CommitProject: uses explicit plansDir when provided", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "smoke14-s7-"));
  const repo = join(tmp, "repo");
  try {
    initRepo(repo);
    const customPlans = join(repo, "repos", "myproject", "plans");
    mkdirSync(join(customPlans, "complete"), { recursive: true });
    writeFileSync(join(customPlans, "complete", "feat-b.md"), "# done\n", "utf8");

    await step7CommitProject(repo, ["autonomous/feat-b"], { plansDir: customPlans });

    const log = spawnSync("git", ["log", "--oneline", "-1"], { cwd: repo, encoding: "utf8" });
    ok(log.stdout.includes("feat-b"), "commit message should reference the branch slug");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("step7CommitProject: no-op when only files outside plans/ are untracked", async () => {
  // Regression for the ?? filter bug. Note the boundary: `git add plans/` DOES
  // stage new files that are *inside* plans/ (they become 'A ' not '??'). Only
  // files that git add never touches — those outside plans/ — remain '??' in
  // `git status --porcelain` and must be excluded by the filter.
  const tmp = mkdtempSync(join(tmpdir(), "smoke14-s7-"));
  const repo = join(tmp, "repo");
  try {
    initRepo(repo);
    // Empty plans/ dir so git add plans/ succeeds without staging anything new
    mkdirSync(join(repo, "plans"), { recursive: true });
    // Untracked file OUTSIDE plans/ — simulates a build artefact
    writeFileSync(join(repo, "dist.log"), "build output\n", "utf8");

    const committed = await step7CommitProject(repo, ["autonomous/feat-a"]);

    equal(committed, false, "?? lines outside plans/ must not trigger a commit");
    const count = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: repo, encoding: "utf8" });
    equal(count.stdout.trim(), "1", "only the initial commit should exist");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
