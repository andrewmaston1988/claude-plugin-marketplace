import { test } from "node:test";
import { ok, equal, strictEqual } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectPath, close } from "./connection.mjs";
import { rowAdd, rowGet, rowUpdate } from "./rows.mjs";
import { projectAdd } from "./projects.mjs";

const PROJECT = "testproject";

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "rows-test-"));
  mkdirSync(join(tmp, ".git"), { recursive: true });
  const db = connectPath(join(tmp, "pipeline.db"));
  projectAdd(db, { name: PROJECT, rootPath: tmp });
  return { tmp, db };
}

function teardown(tmp, db) {
  try { close(db); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

test("rvw_effort: defaults to 'high' on fresh row", () => {
  const { tmp, db } = setup();
  try {
    rowAdd(db, PROJECT, { feature: "feat-default", planFile: "/p.md", stage: "queued" });
    const row = rowGet(db, PROJECT, "feat-default");
    ok(row, "row should exist");
    equal(row.rvw_effort, "high", "rvw_effort should default to high");
  } finally { teardown(tmp, db); }
});

test("rvw_effort: explicit value set via rowAdd is round-tripped", () => {
  const { tmp, db } = setup();
  try {
    rowAdd(db, PROJECT, { feature: "feat-explicit", planFile: "/p.md", stage: "queued", rvwEffort: "max" });
    const row = rowGet(db, PROJECT, "feat-explicit");
    ok(row, "row should exist");
    equal(row.rvw_effort, "max", "rvw_effort should be 'max'");
  } finally { teardown(tmp, db); }
});

test("rvw_effort: updated via rowUpdate", () => {
  const { tmp, db } = setup();
  try {
    rowAdd(db, PROJECT, { feature: "feat-update", planFile: "/p.md", stage: "queued" });
    rowUpdate(db, PROJECT, "feat-update", { rvw_effort: "medium" });
    const row = rowGet(db, PROJECT, "feat-update");
    equal(row.rvw_effort, "medium", "rvw_effort should be updated to medium");
  } finally { teardown(tmp, db); }
});

test("rvw_effort: independent from d_effort and r_effort", () => {
  const { tmp, db } = setup();
  try {
    rowAdd(db, PROJECT, {
      feature: "feat-independent",
      planFile: "/p.md",
      stage: "queued",
      rEffort: "low",
      dEffort: "medium",
      rvwEffort: "max",
    });
    const row = rowGet(db, PROJECT, "feat-independent");
    equal(row.r_effort, "low",  "r_effort should be low");
    equal(row.d_effort, "medium", "d_effort should be medium");
    equal(row.rvw_effort, "max", "rvw_effort should be max");
  } finally { teardown(tmp, db); }
});

test("schema_version: SCHEMA_V8 applied (rvw_effort column exists)", () => {
  const { tmp, db } = setup();
  try {
    const cols = db.prepare("PRAGMA table_info(pipeline_rows)").all().map(c => c.name);
    ok(cols.includes("rvw_effort"), "rvw_effort column must exist on pipeline_rows");
    const version = db.prepare("SELECT MAX(version) AS v FROM schema_version").get();
    ok(version.v >= 8, `schema_version must be >= 8, got ${version.v}`);
  } finally { teardown(tmp, db); }
});

test("effort: r_effort defaults to 'high' on fresh row (omitted arg)", () => {
  const { tmp, db } = setup();
  try {
    rowAdd(db, PROJECT, { feature: "feat-r-default", planFile: "/p.md", stage: "queued" });
    const row = rowGet(db, PROJECT, "feat-r-default");
    equal(row.r_effort, "high", "r_effort should default to 'high'");
  } finally { teardown(tmp, db); }
});

test("effort: d_effort defaults to 'medium' on fresh row (omitted arg)", () => {
  const { tmp, db } = setup();
  try {
    rowAdd(db, PROJECT, { feature: "feat-d-default", planFile: "/p.md", stage: "queued" });
    const row = rowGet(db, PROJECT, "feat-d-default");
    equal(row.d_effort, "medium", "d_effort should default to 'medium'");
  } finally { teardown(tmp, db); }
});

test("effort: q_effort defaults to 'low' on fresh row (omitted arg)", () => {
  const { tmp, db } = setup();
  try {
    rowAdd(db, PROJECT, { feature: "feat-q-default", planFile: "/p.md", stage: "queued" });
    const row = rowGet(db, PROJECT, "feat-q-default");
    equal(row.q_effort, "low", "q_effort should default to 'low'");
  } finally { teardown(tmp, db); }
});

test("effort: explicit values round-trip", () => {
  const { tmp, db } = setup();
  try {
    rowAdd(db, PROJECT, {
      feature: "feat-explicit-efforts",
      planFile: "/p.md",
      stage: "queued",
      rEffort: "max",
      dEffort: "max",
      qEffort: "max",
    });
    const row = rowGet(db, PROJECT, "feat-explicit-efforts");
    equal(row.r_effort, "max");
    equal(row.d_effort, "max");
    equal(row.q_effort, "max");
  } finally { teardown(tmp, db); }
});

test("effort: partial set — omitted columns keep defaults", () => {
  const { tmp, db } = setup();
  try {
    rowAdd(db, PROJECT, {
      feature: "feat-partial",
      planFile: "/p.md",
      stage: "queued",
      dEffort: "max",
    });
    const row = rowGet(db, PROJECT, "feat-partial");
    equal(row.r_effort, "high",   "r_effort should still default to 'high'");
    equal(row.d_effort, "max",    "d_effort should be the explicit 'max'");
    equal(row.q_effort, "low",    "q_effort should still default to 'low'");
  } finally { teardown(tmp, db); }
});

test("schema_version: SCHEMA_V11 applied (backfill migration)", () => {
  const { tmp, db } = setup();
  try {
    const version = db.prepare("SELECT MAX(version) AS v FROM schema_version").get();
    ok(version.v >= 11, `schema_version must be >= 11, got ${version.v}`);
  } finally { teardown(tmp, db); }
});
