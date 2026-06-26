import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reclaimPlanIfMisplaced } from "../src/plans/reclaim.mjs";

test("reclaimPlanIfMisplaced: no-op when plan file exists at expected path", () => {
  const tmp = mkdtempSync(join(tmpdir(), "reclaim-"));
  try {
    const planPath = join(tmp, "foo.md");
    writeFileSync(planPath, "# plan\n", "utf8");

    const result = reclaimPlanIfMisplaced(planPath);

    assert.deepEqual(result, { moved: false });
    assert.ok(existsSync(planPath), "file must still be at original path");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reclaimPlanIfMisplaced: recovers plan from complete/ when missing at root", () => {
  const tmp = mkdtempSync(join(tmpdir(), "reclaim-"));
  try {
    mkdirSync(join(tmp, "complete"));
    const completePath = join(tmp, "complete", "foo.md");
    writeFileSync(completePath, "# plan\n", "utf8");

    const planPath = join(tmp, "foo.md");
    const result = reclaimPlanIfMisplaced(planPath);

    assert.equal(result.moved, true);
    assert.equal(result.from, completePath);
    assert.ok(existsSync(planPath), "file must be restored to root plans dir");
    assert.ok(!existsSync(completePath), "file must be removed from complete/");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reclaimPlanIfMisplaced: returns moved=false when file absent from both locations", () => {
  const tmp = mkdtempSync(join(tmpdir(), "reclaim-"));
  try {
    const planPath = join(tmp, "foo.md");

    const result = reclaimPlanIfMisplaced(planPath);

    assert.deepEqual(result, { moved: false });
    assert.ok(!existsSync(planPath), "no file should be created");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
