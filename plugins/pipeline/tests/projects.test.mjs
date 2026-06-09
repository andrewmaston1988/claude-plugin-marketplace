// smoke-7-projects.mjs — registry CRUD + row scoping under the unified DB.
//
// Plan #1 (pipeline-plugin-unified-db-and-registry) acceptance:
//  - projects table CRUD
//  - row queries scoped by project
//  - composite (project, feature) primary key allows the same `feature` slug
//    across two projects without collision
//  - listEnabledProjects respects the enabled flag

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  connectPath, close,
  projectAdd, projectList, projectGetByName, projectGetByPath,
  projectSetEnabled, projectRemove, listEnabledProjects,
  rowAdd, rowGet, rowsList, rowUpdate, rowDelete,
  validateProjectName, validateProjectPath,
} from "../scripts/pipeline-db/index.mjs";

function makeFakeRepo(parent, name) {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true });
  // git init so the validator accepts it as a git repo
  const r = spawnSync("git", ["init", "--quiet"], { cwd: path, stdio: "ignore" });
  if (r.status !== 0) throw new Error(`git init failed for ${path}`);
  writeFileSync(join(path, "README.md"), "test\n", "utf8");
  return path;
}

test("validation: name shape", () => {
  assert.equal(validateProjectName("good-name"), null);
  assert.equal(validateProjectName("good_name_123"), null);
  assert.ok(validateProjectName("Bad Name"));
  assert.ok(validateProjectName(""));
  assert.ok(validateProjectName("-leading-hyphen"));
});

test("validation: path must exist", () => {
  assert.ok(validateProjectPath("/this/path/does/not/exist"));
});

test("validation: path must be a git repo", () => {
  const tmp = mkdtempSync(join(tmpdir(), "smoke7-"));
  try {
    const dir = join(tmp, "no-git");
    mkdirSync(dir);
    assert.ok(validateProjectPath(dir), "non-git dir should be rejected");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("projectAdd + projectList + projectGetByName", () => {
  const tmp = mkdtempSync(join(tmpdir(), "smoke7-"));
  try {
    const repoA = makeFakeRepo(tmp, "repoA");
    const db = connectPath(":memory:");

    const added = projectAdd(db, { name: "alpha", rootPath: repoA });
    assert.equal(added.name, "alpha");
    assert.equal(added.root_path, repoA);
    assert.equal(added.enabled, 1);

    const all = projectList(db);
    assert.equal(all.length, 1);
    assert.equal(all[0].name, "alpha");

    const byName = projectGetByName(db, "alpha");
    assert.ok(byName);
    assert.equal(byName.root_path, repoA);

    const byPath = projectGetByPath(db, repoA);
    assert.equal(byPath.name, "alpha");

    close(db);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("projectAdd rejects duplicate name", () => {
  const tmp = mkdtempSync(join(tmpdir(), "smoke7-"));
  try {
    const repoA = makeFakeRepo(tmp, "repoA");
    const repoB = makeFakeRepo(tmp, "repoB");
    const db = connectPath(":memory:");
    projectAdd(db, { name: "alpha", rootPath: repoA });
    assert.throws(() => projectAdd(db, { name: "alpha", rootPath: repoB }), /already registered/);
    close(db);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("projectAdd rejects duplicate path", () => {
  const tmp = mkdtempSync(join(tmpdir(), "smoke7-"));
  try {
    const repoA = makeFakeRepo(tmp, "repoA");
    const db = connectPath(":memory:");
    projectAdd(db, { name: "alpha", rootPath: repoA });
    assert.throws(() => projectAdd(db, { name: "beta", rootPath: repoA }), /already registered/);
    close(db);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("listEnabledProjects filters by enabled flag", () => {
  const tmp = mkdtempSync(join(tmpdir(), "smoke7-"));
  try {
    const repoA = makeFakeRepo(tmp, "repoA");
    const repoB = makeFakeRepo(tmp, "repoB");
    const db = connectPath(":memory:");
    projectAdd(db, { name: "alpha", rootPath: repoA });
    projectAdd(db, { name: "beta",  rootPath: repoB });
    assert.equal(listEnabledProjects(db).size, 2);
    projectSetEnabled(db, "beta", 0);
    const enabled = listEnabledProjects(db);
    assert.equal(enabled.size, 1);
    assert.ok(enabled.has("alpha"));
    assert.equal(enabled.has("beta"), false);
    close(db);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("composite (project, feature) allows same feature across projects", () => {
  const tmp = mkdtempSync(join(tmpdir(), "smoke7-"));
  try {
    const repoA = makeFakeRepo(tmp, "repoA");
    const repoB = makeFakeRepo(tmp, "repoB");
    const db = connectPath(":memory:");
    projectAdd(db, { name: "alpha", rootPath: repoA });
    projectAdd(db, { name: "beta",  rootPath: repoB });

    // Same feature slug in both projects — must not collide.
    rowAdd(db, "alpha", { feature: "shared-name", planFile: "p.md", stage: "queued" });
    rowAdd(db, "beta",  { feature: "shared-name", planFile: "q.md", stage: "dev" });

    const rA = rowGet(db, "alpha", "shared-name");
    const rB = rowGet(db, "beta",  "shared-name");
    assert.equal(rA.stage, "queued");
    assert.equal(rB.stage, "dev");
    assert.equal(rA.plan_file, "p.md");
    assert.equal(rB.plan_file, "q.md");

    // rowsList scoped to project
    assert.equal(rowsList(db, "alpha").length, 1);
    assert.equal(rowsList(db, "beta").length, 1);

    // update scoped: alpha's update does not affect beta's row
    rowUpdate(db, "alpha", "shared-name", { stage: "merge", qa_pass: 1 });
    assert.equal(rowGet(db, "alpha", "shared-name").stage, "merge");
    assert.equal(rowGet(db, "beta",  "shared-name").stage, "dev");

    // delete scoped
    rowDelete(db, "alpha", "shared-name");
    assert.equal(rowGet(db, "alpha", "shared-name"), null);
    assert.ok(rowGet(db, "beta", "shared-name"));

    close(db);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("projectRemove without --purge fails loudly when rows exist", () => {
  const tmp = mkdtempSync(join(tmpdir(), "smoke7-"));
  try {
    const repoA = makeFakeRepo(tmp, "repoA");
    const db = connectPath(":memory:");
    projectAdd(db, { name: "alpha", rootPath: repoA });
    rowAdd(db, "alpha", { feature: "f1", planFile: "p.md", stage: "queued" });
    assert.throws(() => projectRemove(db, "alpha"), /pass --purge/);
    // project still registered after failed remove
    assert.ok(projectGetByName(db, "alpha"));
    close(db);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("projectRemove --purge cascades", () => {
  const tmp = mkdtempSync(join(tmpdir(), "smoke7-"));
  try {
    const repoA = makeFakeRepo(tmp, "repoA");
    const db = connectPath(":memory:");
    projectAdd(db, { name: "alpha", rootPath: repoA });
    rowAdd(db, "alpha", { feature: "f1", planFile: "p.md", stage: "queued" });
    rowAdd(db, "alpha", { feature: "f2", planFile: "q.md", stage: "dev" });

    const ok = projectRemove(db, "alpha", { purge: true });
    assert.equal(ok, true);
    assert.equal(projectGetByName(db, "alpha"), null);
    assert.equal(rowsList(db, "alpha").length, 0);
    close(db);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("projectRemove returns false for unknown project", () => {
  const db = connectPath(":memory:");
  assert.equal(projectRemove(db, "ghost"), false);
  close(db);
});
