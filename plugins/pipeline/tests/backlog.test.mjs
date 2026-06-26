// backlog.test.mjs — virtual backlog rows from plans directory.
//
// Plan: pipeline-plugin-plans-dir-backlog-parity acceptance:
//  - loadBacklog returns unqueued .md files from plans_dir
//  - plans_dir defaults to <root>/plans/ when not set
//  - custom plans_dir is used when set
//  - queued files don't appear in backlog
//  - non-.md files ignored
//  - plans/complete/ subdirectory excluded (top-level only)
//  - directory doesn't exist → returns []
//  - virtual rows have virtual=true flag

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  connectPath, close,
  projectAdd, projectUpdate, rowAdd,
  rowsList,
} from "../src/db/index.mjs";
import { loadBacklog } from "../src/dashboard/shared/load-backlog.mjs";

// Pin the default plansDir template so the suite never reads the operator's real
// ~/.pipeline/config.json (whose plansDir may point outside the temp repo).
const TEST_CFG = { plansDir: "plans" };

function makeFakeRepo(parent, name) {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true });
  spawnSync("git", ["init", "--quiet"], { cwd: path, stdio: "ignore" });
  writeFileSync(join(path, "README.md"), "test\n", "utf8");
  return path;
}

test("loadBacklog: default plans_dir (root/plans/)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "backlog-"));
  try {
    const db = connectPath(":memory:");
    const repoA = makeFakeRepo(tmp, "repoA");
    const plansDir = join(repoA, "plans");
    mkdirSync(plansDir);
    writeFileSync(join(plansDir, "plan1.md"), "# Plan 1\n");
    writeFileSync(join(plansDir, "plan2.md"), "# Plan 2\n");
    writeFileSync(join(plansDir, "plan3.md"), "# Plan 3\n");

    projectAdd(db, { name: "proj-a", rootPath: repoA });

    // Queue plan1, so it shouldn't appear in backlog
    rowAdd(db, "proj-a", { feature: "plan1", planFile: join(plansDir, "plan1.md"), stage: "dev" });

    const backlog = loadBacklog(db, "proj-a", TEST_CFG);
    assert.equal(backlog.length, 2, "should return 2 unqueued plans");
    assert.equal(backlog.some(r => r.feature === "plan2"), true);
    assert.equal(backlog.some(r => r.feature === "plan3"), true);
    assert.equal(backlog.every(r => r.stage === "backlog"), true);
    assert.equal(backlog.every(r => r.virtual === true), true);
    close(db);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadBacklog: custom plans_dir", () => {
  const tmp = mkdtempSync(join(tmpdir(), "backlog-"));
  try {
    const db = connectPath(":memory:");
    const repoA = makeFakeRepo(tmp, "repoA");
    const customDir = join(tmp, "custom-plans");
    mkdirSync(customDir);
    writeFileSync(join(customDir, "plan-x.md"), "# Plan X\n");
    writeFileSync(join(customDir, "plan-y.md"), "# Plan Y\n");

    projectAdd(db, { name: "proj-a", rootPath: repoA, plansDir: customDir });

    const backlog = loadBacklog(db, "proj-a", TEST_CFG);
    assert.equal(backlog.length, 2);
    assert.equal(backlog.some(r => r.feature === "plan-x"), true);
    assert.equal(backlog.some(r => r.feature === "plan-y"), true);
    close(db);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadBacklog: directory doesn't exist → returns []", () => {
  const tmp = mkdtempSync(join(tmpdir(), "backlog-"));
  try {
    const db = connectPath(":memory:");
    const repoA = makeFakeRepo(tmp, "repoA");
    // Don't create plans/ directory

    projectAdd(db, { name: "proj-a", rootPath: repoA });

    const backlog = loadBacklog(db, "proj-a", TEST_CFG);
    assert.equal(backlog.length, 0);
    close(db);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadBacklog: ignores non-.md files", () => {
  const tmp = mkdtempSync(join(tmpdir(), "backlog-"));
  try {
    const db = connectPath(":memory:");
    const repoA = makeFakeRepo(tmp, "repoA");
    const plansDir = join(repoA, "plans");
    mkdirSync(plansDir);
    writeFileSync(join(plansDir, "plan1.md"), "# Plan 1\n");
    writeFileSync(join(plansDir, "notes.txt"), "some notes\n");
    writeFileSync(join(plansDir, "data.json"), "{}");

    projectAdd(db, { name: "proj-a", rootPath: repoA });

    const backlog = loadBacklog(db, "proj-a", TEST_CFG);
    assert.equal(backlog.length, 1);
    assert.equal(backlog[0].feature, "plan1");
    close(db);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadBacklog: excludes complete/ subdirectory (top-level only)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "backlog-"));
  try {
    const db = connectPath(":memory:");
    const repoA = makeFakeRepo(tmp, "repoA");
    const plansDir = join(repoA, "plans");
    mkdirSync(plansDir);
    mkdirSync(join(plansDir, "complete"));
    writeFileSync(join(plansDir, "active.md"), "# Active\n");
    writeFileSync(join(plansDir, "complete", "old.md"), "# Old\n");

    projectAdd(db, { name: "proj-a", rootPath: repoA });

    const backlog = loadBacklog(db, "proj-a", TEST_CFG);
    assert.equal(backlog.length, 1);
    assert.equal(backlog[0].feature, "active");
    close(db);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadBacklog: project doesn't exist → returns []", () => {
  const db = connectPath(":memory:");
  const backlog = loadBacklog(db, "nonexistent");
  assert.equal(backlog.length, 0);
  close(db);
});

test("projectUpdate: set plans_dir on existing project", () => {
  const tmp = mkdtempSync(join(tmpdir(), "backlog-"));
  try {
    const db = connectPath(":memory:");
    const repoA = makeFakeRepo(tmp, "repoA");
    const customDir = join(tmp, "custom-plans");
    mkdirSync(customDir);
    writeFileSync(join(customDir, "plan-new.md"), "# New\n");

    projectAdd(db, { name: "proj-a", rootPath: repoA });
    let project = projectUpdate(db, "proj-a", { plansDir: customDir });
    assert.equal(project.plans_dir, customDir);

    const backlog = loadBacklog(db, "proj-a", TEST_CFG);
    assert.equal(backlog.length, 1);
    assert.equal(backlog[0].feature, "plan-new");
    close(db);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
