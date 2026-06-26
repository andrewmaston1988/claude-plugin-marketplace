import { test } from "node:test";
import { equal } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PIPELINE_SUPPRESS_DEPRECATED = "1";

import { depsMet, parseDepRef } from "../src/orchestrator/deps.mjs";
import { validateCrossProjectDep, clusterTypeAudit } from "../src/cli/queue.mjs";
import { connectPath, close } from "../src/db/connection.mjs";
import { projectAdd } from "../src/db/projects.mjs";
import { rowAdd, rowUpdate } from "../src/db/rows.mjs";

test("parseDepRef: splits project:feature; bare stays same-project", () => {
  equal(parseDepRef("esg:feat-x").project, "esg");
  equal(parseDepRef("esg:feat-x").feature, "feat-x");
  equal(parseDepRef("bare-feat").project, null);
  equal(parseDepRef("bare-feat").feature, "bare-feat");
});

test("depsMet: cross-project dep holds until the other project's row is done", () => {
  const root = mkdtempSync(join(tmpdir(), "xproj-deps-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(join(root, ".pipeline", "pipeline.db"));
  try {
    projectAdd(db, { name: "proj-b", rootPath: root });
    rowAdd(db, "proj-b", { feature: "dep", planFile: "dep.md", stage: "dev", branch: "—" });
    const row = { feature: "x", depends_on: "proj-b:dep" };
    const log = () => {};

    equal(depsMet(row, [], log, null, db), false, "holds while prereq not done");
    rowUpdate(db, "proj-b", "dep", { stage: "done" });
    equal(depsMet(row, [], log, null, db), true, "releases when prereq done");
  } finally { close(db); rmSync(root, { recursive: true, force: true }); }
});

test("clusterTypeAudit: lists plans missing *Type:*", () => {
  const dir = mkdtempSync(join(tmpdir(), "cluster-audit-"));
  const a = join(dir, "a.md"), b = join(dir, "b.md");
  writeFileSync(a, "# A\n*Type:* dev\n");
  writeFileSync(b, "# B\n(no type)\n");
  try {
    equal(clusterTypeAudit([a]).length, 0);
    const missing = clusterTypeAudit([a, b]);
    equal(missing.length, 1);
    equal(missing[0], b);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("validateCrossProjectDep: ok when referenced project registered; error otherwise", () => {
  const root = mkdtempSync(join(tmpdir(), "xproj-val-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(join(root, ".pipeline", "pipeline.db"));
  try {
    projectAdd(db, { name: "esg", rootPath: root });
    equal(validateCrossProjectDep("esg:feat-x", db)[0], true);
    equal(validateCrossProjectDep("ghost:feat-x", db)[0], false);
    equal(validateCrossProjectDep("bare-same-project", db)[0], true); // not cross-project → ok
  } finally { close(db); rmSync(root, { recursive: true, force: true }); }
});

test("depsMet: unknown cross-project ref holds; bare same-project unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "xproj-deps2-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(join(root, ".pipeline", "pipeline.db"));
  try {
    projectAdd(db, { name: "p", rootPath: root });
    const log = () => {};
    equal(depsMet({ feature: "x", depends_on: "ghost:none" }, [], log, null, db), false);
    const allRows = [{ feature: "done-feat", stage: "done" }];
    equal(depsMet({ feature: "x", depends_on: "done-feat" }, allRows, log, null, db), true);
    equal(depsMet({ feature: "x", depends_on: "missing" }, allRows, log, null, db), false);
  } finally { close(db); rmSync(root, { recursive: true, force: true }); }
});
