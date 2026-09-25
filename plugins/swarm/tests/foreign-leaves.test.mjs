import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listLeaves } from "../src/results.mjs";
import { runGradeable } from "../src/grade-nudge.mjs";

function runDir() {
  const dir = mkdtempSync(join(tmpdir(), "swarm-foreign-leaves-"));
  mkdirSync(join(dir, "results"));
  return dir;
}

function result(dir, id) {
  writeFileSync(join(dir, "results", `${id}.json`), JSON.stringify({ id, model: "m", ok: true }));
}

function manifest(dir, tasks) {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ tasks }));
}

test("listLeaves keeps forEach clone results belonging to a manifest task", () => {
  const dir = runDir();
  try {
    manifest(dir, [{ id: "fix", forEach: { from: "items", path: "", maxItems: 4 } }]);
    for (const id of ["fix", "fix[0]", "fix[1]", "old"]) result(dir, id);
    deepEqual(listLeaves(dir).map((leaf) => leaf.id).sort(), ["fix", "fix[0]", "fix[1]"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listLeaves keeps results from child-manifest tasks", () => {
  const dir = runDir();
  try {
    manifest(dir, [{ id: "audit", child: [{ id: "find" }, { id: "verify" }] }]);
    for (const id of ["audit", "audit~find", "audit~verify", "old"]) result(dir, id);
    deepEqual(listLeaves(dir).map((leaf) => leaf.id).sort(), ["audit", "audit~find", "audit~verify"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listLeaves keeps every result when a legacy run has no manifest", () => {
  const dir = runDir();
  try {
    result(dir, "current");
    result(dir, "old");
    deepEqual(listLeaves(dir).map((leaf) => leaf.id).sort(), ["current", "old"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the grade nudge count excludes results outside the run manifest", () => {
  const dir = runDir();
  try {
    manifest(dir, [{ id: "current" }]);
    result(dir, "current");
    result(dir, "old");
    equal(runGradeable(dir, { cfg: { grading: { enabled: true } }, graded: new Set() }).count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
