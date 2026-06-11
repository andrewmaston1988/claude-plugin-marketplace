// plan-base-branch-chaining — DB-layer contract: the V4 migration adds
// waits_on + base_branch, and rowAdd/rowGet round-trip them. The orchestrator
// gate (depsMet waits_on + ancestor check) and queue-cluster topo ordering are
// exercised at the integration layer; this pins the schema/persistence floor
// the rest builds on.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectPath, close, projectAdd, rowAdd, rowGet } from "../scripts/pipeline-db/index.mjs";

const PROJECT = "testproject";

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "base-branch-chaining-"));
  const dbPath = join(tmp, "pipeline.db");
  const repo = join(tmp, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const db = connectPath(dbPath);
  projectAdd(db, { name: PROJECT, rootPath: repo });
  return { tmp, db };
}
function teardown(tmp, db) {
  try { close(db); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

test("V4 migration adds waits_on and base_branch columns", () => {
  const { tmp, db } = setup();
  try {
    const cols = db.prepare("PRAGMA table_info(pipeline_rows)").all().map(c => c.name);
    ok(cols.includes("waits_on"), "waits_on column present");
    ok(cols.includes("base_branch"), "base_branch column present");
  } finally { teardown(tmp, db); }
});

test("rowAdd persists waitsOn + baseBranch; rowGet returns them", () => {
  const { tmp, db } = setup();
  try {
    rowAdd(db, PROJECT, {
      feature: "dependent", planFile: "/p/dependent.md", stage: "queued",
      waitsOn: "prereq", baseBranch: "autonomous/prereq",
    });
    const row = rowGet(db, PROJECT, "dependent");
    equal(row.waits_on, "prereq");
    equal(row.base_branch, "autonomous/prereq");
  } finally { teardown(tmp, db); }
});

test("rowAdd without chaining leaves waits_on / base_branch null", () => {
  const { tmp, db } = setup();
  try {
    rowAdd(db, PROJECT, { feature: "solo", planFile: "/p/solo.md", stage: "queued" });
    const row = rowGet(db, PROJECT, "solo");
    equal(row.waits_on, null);
    equal(row.base_branch, null);
  } finally { teardown(tmp, db); }
});
